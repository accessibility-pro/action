/**
 * GitHub REST calls: find the pull request and keep one sticky comment.
 *
 * Direct REST over the token, rather than `@actions/github`, keeps the
 * action dependency-free. No user-controlled value is ever interpolated
 * into a shell command; the comment body travels as a JSON field.
 */

import { readFileSync } from 'node:fs';
import { httpRequestWithRetry, parseJson } from './http.mjs';
import * as core from './core.mjs';
import { COMMENT_MARKER } from './render.mjs';

/**
 * GitHub sets `GITHUB_API_URL` on every runner, including Enterprise
 * Server installations where it is not api.github.com. Reading it is
 * what makes this action work on GHES at all.
 */
const API = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');

/** GitHub's own repo-name rules; anchored so nothing walks the path. */
const REPO_RE = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;

function apiHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'accessibility-pro-action',
  };
}

/** Read the workflow event payload, or null when it is unavailable. */
export function readEvent() {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    core.debug(`Could not read the event payload: ${err.message}`);
    return null;
  }
}

/**
 * The pull request this run belongs to, if any.
 *
 * Covers `pull_request`, `pull_request_target`, and the case where a
 * workflow runs on `issue_comment` against a PR - all three are ways a
 * team ends up wanting the comment on the same thread.
 */
export function pullRequestNumber(event) {
  const number =
    event?.pull_request?.number ??
    (event?.issue?.pull_request ? event.issue.number : undefined);
  return Number.isInteger(number) ? number : null;
}

export function repository() {
  const repo = process.env.GITHUB_REPOSITORY || '';
  if (!REPO_RE.test(repo)) {
    throw new Error(`Unexpected GITHUB_REPOSITORY value: ${repo || '(unset)'}`);
  }
  return repo;
}

/** Find this action's previous comment on the PR, if it left one. */
async function findExistingComment(repo, prNumber, token) {
  for (let page = 1; page <= 10; page++) {
    const res = await httpRequestWithRetry(
      `${API}/repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
      { headers: apiHeaders(token), timeoutMs: 30_000, retries: 1, retryDelayMs: 2_000 }
    );
    if (res.status === 403 || res.status === 404) return { denied: res.status };
    if (res.status !== 200) return { denied: res.status };
    const comments = parseJson(res, 'List PR comments');
    const match = comments.find((c) => (c.body || '').includes(COMMENT_MARKER));
    if (match) return { comment: match };
    if (comments.length < 100) return {};
  }
  return {};
}

/**
 * Post the results, updating this action's previous comment in place.
 *
 * Sticky by default because the alternative is one comment per push:
 * on a branch with fifteen commits the reviewer scrolls past fourteen
 * stale accessibility verdicts to reach the current one.
 *
 * Never throws. A repository whose workflow lacks
 * `permissions: pull-requests: write`, or a fork PR whose token is
 * read-only, should get a warning and a job summary - not a red build
 * for a commenting failure.
 */
export async function upsertComment({ repo, prNumber, body, token, mode }) {
  try {
    let existing = null;
    if (mode === 'sticky') {
      const found = await findExistingComment(repo, prNumber, token);
      if (found.denied) {
        warnNoPermission(found.denied);
        return false;
      }
      existing = found.comment ?? null;
    }

    const post = () =>
      httpRequestWithRetry(`${API}/repos/${repo}/issues/${prNumber}/comments`, {
        method: 'POST',
        headers: apiHeaders(token),
        body: JSON.stringify({ body }),
        timeoutMs: 30_000,
        retries: 1,
        retryDelayMs: 2_000,
      });

    let res;
    if (existing) {
      res = await httpRequestWithRetry(
        `${API}/repos/${repo}/issues/comments/${existing.id}`,
        {
          method: 'PATCH',
          headers: apiHeaders(token),
          body: JSON.stringify({ body }),
          timeoutMs: 30_000,
          retries: 1,
          retryDelayMs: 2_000,
        }
      );
      // A comment written under a different identity (a PAT before, the
      // workflow token now) cannot be edited by this token. Posting a
      // fresh one beats reporting no results at all.
      if (res.status === 403 || res.status === 404) {
        core.debug(
          `Cannot edit comment ${existing.id} (HTTP ${res.status}); posting a new one.`
        );
        existing = null;
        res = await post();
      }
    } else {
      res = await post();
    }

    if (res.status === 403 || res.status === 404) {
      warnNoPermission(res.status);
      return false;
    }
    if (res.status < 200 || res.status >= 300) {
      core.warning(
        `Could not post the PR comment (HTTP ${res.status}). The scan result ` +
          'is unaffected; see the job summary.'
      );
      return false;
    }
    core.info(
      existing
        ? `Updated the existing comment on pull request #${prNumber}.`
        : `Posted a comment on pull request #${prNumber}.`
    );
    return true;
  } catch (err) {
    core.warning(
      `Could not post the PR comment (${err.message}). The scan result is ` +
        'unaffected; see the job summary.'
    );
    return false;
  }
}

function warnNoPermission(status) {
  core.warning(
    `The workflow token cannot comment on this pull request (HTTP ${status}). ` +
      'Add `permissions: { pull-requests: write }` to the job. Pull requests ' +
      'from forks get a read-only token by default, so comments are expected ' +
      'to be skipped there. Results are in the job summary either way.'
  );
}
