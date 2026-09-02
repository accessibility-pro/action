#!/usr/bin/env node
/**
 * Accessibility Pro Scan - GitHub Action entrypoint.
 *
 * One scan request per URL, one verdict, one comment. Everything the
 * action reports comes from the `POST /api/ci/scan` response; the scan
 * is never re-fetched, so nothing that response carries can be lost on
 * the way to the reader.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import * as core from './core.mjs';
import { FAIL_ON_CHOICES, mintOidcToken, resolveGate, runScan } from './api.mjs';
import {
  quotaLine,
  renderComment,
  renderSummary,
  summarise,
  warningKind,
} from './render.mjs';
import { toSarif } from './sarif.mjs';
import { pullRequestNumber, readEvent, repository, upsertComment } from './github.mjs';

const ACTION_VERSION = '2.1.0';
const WCAG_LEVELS = ['A', 'AA', 'AAA'];
const COMMENT_MODES = ['sticky', 'new', 'off'];

/** Trailing slashes here become `//` mid-path later. Normalise once. */
function normaliseOrigin(value, inputName) {
  const trimmed = value.replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Input '${inputName}' must be an absolute URL (got '${value}').`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Input '${inputName}' must be http or https (got '${value}').`);
  }
  return trimmed;
}

function readConfig() {
  const urls = core.getListInput('url', { required: true });
  if (!urls.length) throw new Error("Input required and not supplied: url");

  const wcagLevel = core.getInput('wcag-level').toUpperCase() || 'AA';
  if (!WCAG_LEVELS.includes(wcagLevel)) {
    throw new Error(
      `Input 'wcag-level' must be one of ${WCAG_LEVELS.join(', ')} (got '${wcagLevel}').`
    );
  }

  const failOn = (core.getInput('fail-on') || 'error').toLowerCase();
  const gate = resolveGate({
    failOn,
    thresholdsJson: core.getInput('thresholds'),
  });

  // `comment-on-pr: false` is the v1 spelling. Honour it so upgrading
  // the version tag does not silently start commenting on repositories
  // that had turned it off.
  let commentMode = (core.getInput('comment') || 'sticky').toLowerCase();
  if (!COMMENT_MODES.includes(commentMode)) {
    throw new Error(
      `Input 'comment' must be one of ${COMMENT_MODES.join(', ')} (got '${commentMode}').`
    );
  }
  const legacyComment = core.getInput('comment-on-pr').toLowerCase();
  if (legacyComment === 'false') {
    core.warning(
      "Input 'comment-on-pr' is deprecated; use `comment: off`. Honouring it for now."
    );
    commentMode = 'off';
  }

  const timeoutMinutes = Number(core.getInput('timeout-minutes') || '15');
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0 || timeoutMinutes > 60) {
    throw new Error(
      `Input 'timeout-minutes' must be a number between 1 and 60 (got '${timeoutMinutes}').`
    );
  }

  const retries = Number(core.getInput('retries') || '1');
  if (!Number.isInteger(retries) || retries < 0 || retries > 3) {
    throw new Error(`Input 'retries' must be an integer from 0 to 3 (got '${retries}').`);
  }

  const topIssues = Number(core.getInput('top-issues') || '5');
  if (!Number.isInteger(topIssues) || topIssues < 1 || topIssues > 25) {
    throw new Error(
      `Input 'top-issues' must be an integer from 1 to 25 (got '${core.getInput('top-issues')}').`
    );
  }

  const token = core.getInput('accessibility-pro-token');
  if (token) core.setSecret(token);

  return {
    urls,
    wcagLevel,
    failOn,
    gate,
    engines: core.getListInput('engines', { separator: /[\r\n,]+/ }),
    commentMode,
    annotations: core.getBooleanInput('annotations', true),
    failOnUnrepresentative: core.getBooleanInput('fail-on-unrepresentative', true),
    topIssues,
    sarifFile: core.getInput('sarif-file'),
    resultsFile: core.getInput('results-file'),
    token,
    githubToken: core.getInput('github-token'),
    backendUrl: normaliseOrigin(
      core.getInput('backend-url') || 'https://access-pro-ai-production.up.railway.app',
      'backend-url'
    ),
    reportDomain: normaliseOrigin(
      core.getInput('report-domain') || 'https://www.accessibilitypro.app',
      'report-domain'
    ),
    oidcAudience: core.getInput('oidc-audience') || 'https://api.accessibilitypro.app',
    timeoutMs: Math.round(timeoutMinutes * 60_000),
    retries,
  };
}

function writeJsonFile(path, data) {
  const absolute = resolve(path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return absolute;
}

/**
 * Surface the worst findings in the run's Annotations panel.
 *
 * Capped, and limited to the severities that can fail a build: a
 * reviewer skimming annotations wants the three things that broke the
 * gate, not a hundred advisory notes.
 */
function emitAnnotations(results, { failed, limit = 10 }) {
  // A red annotation on a green run makes people hunt for a failure
  // that is not there, so the level tracks the build verdict rather
  // than the finding's severity alone.
  const annotate = failed ? core.error : core.warning;
  let emitted = 0;
  for (const result of results) {
    for (const issue of result.issues || []) {
      if (emitted >= limit) return;
      const severity = String(issue.severity || '').toLowerCase();
      if (severity !== 'critical' && severity !== 'high') continue;
      const where = issue.location || (issue.occurrence_selectors || [])[0] || result.url;
      annotate(`${issue.title || 'Accessibility violation'} at ${where}`, {
        title: `WCAG ${issue.wcag || '?'} (${severity}) on ${result.url}`,
      });
      emitted += 1;
    }
  }
}

/** Fold per-URL results into the values published as step outputs. */
function aggregate(results) {
  const stats = results.map(summarise);
  const worst = stats.reduce((a, b) => (b.score < a.score ? b : a), stats[0]);
  const sum = (key) => stats.reduce((total, s) => total + s.counts[key], 0);
  return {
    stats,
    worst,
    passed: stats.every((s) => s.passed),
    counts: {
      critical: sum('critical'),
      high: sum('high'),
      medium: sum('medium'),
      low: sum('low'),
    },
    totalIssues: stats.reduce((total, s) => total + s.totalIssues, 0),
    manualReviewCount: stats.reduce((total, s) => total + s.manualReviewCount, 0),
    blocking: stats.flatMap((s) => s.blockingWarnings),
    engines: [...new Set(stats.flatMap((s) => s.engines))],
  };
}

async function main() {
  const config = readConfig();

  core.info(
    `Accessibility Pro Scan v${ACTION_VERSION} - WCAG ${config.wcagLevel}, ` +
      `gate: ${config.gate.describe}.`
  );

  const oidcToken = await mintOidcToken(config.oidcAudience);
  if (!oidcToken && !config.token) {
    core.info(
      'Running on the free tier with IP-bucketed quota. Add `permissions: ' +
        '{ id-token: write }` so quota is counted against this repository ' +
        'rather than shared with every repo behind the same runner IP.'
    );
  }

  const results = [];
  // Scanning is sequential and each page costs a quota unit, so one
  // page failing must not throw away the pages already paid for. Every
  // URL is attempted; unscanned pages are reported at the end and never
  // counted as passing.
  const unscanned = [];
  for (const url of config.urls) {
    core.startGroup(`Scanning ${url}`);
    try {
      const result = await runScan({
        backendUrl: config.backendUrl,
        url,
        wcagLevel: config.wcagLevel,
        gate: config.gate,
        engines: config.engines,
        token: config.token,
        oidcToken,
        timeoutMs: config.timeoutMs,
        retries: config.retries,
      });
      const stats = summarise(result);
      if (!stats.hasBackendVerdict) {
        throw new Error(
          `The backend at ${config.backendUrl} returned a scan of ${url} with no ` +
            'pass/fail verdict. This action reads the verdict from the scanner ' +
            'rather than recomputing one, so it cannot gate on this response. ' +
            'Upgrade the self-hosted backend, or unset `backend-url` to use the ' +
            'hosted service.'
        );
      }
      core.info(
        `Score ${stats.score}/100 - ${stats.counts.critical} critical, ` +
          `${stats.counts.high} high, ${stats.counts.medium} medium, ` +
          `${stats.counts.low} low; ${stats.manualReviewCount} needs review.`
      );
      if (stats.id) core.info(`Report: ${config.reportDomain}/report/${stats.id}`);
      results.push(result);
    } catch (err) {
      unscanned.push({ url, message: err?.message || String(err) });
      core.warning(`Could not scan ${url}: ${err?.message || err}`);
    } finally {
      core.endGroup();
    }
  }

  // Nothing to report on: re-throw so the top-level handler renders the
  // one error that matters rather than a summary of zero scans.
  if (results.length === 0) {
    const first = unscanned[0];
    throw Object.assign(new Error(first?.message || 'No URL could be scanned.'), {
      status: 'scan-failed',
    });
  }

  const totals = aggregate(results);

  if (config.resultsFile) {
    const path = writeJsonFile(config.resultsFile, results);
    core.setOutput('results-file', path);
    core.info(`Wrote the raw scan payload to ${path}.`);
  }
  if (config.sarifFile) {
    const path = writeJsonFile(config.sarifFile, toSarif(results, { version: ACTION_VERSION }));
    core.setOutput('sarif-file', path);
    core.info(
      `Wrote SARIF to ${path}. Upload it with github/codeql-action/upload-sarif ` +
        'to track findings in the Security tab across runs.'
    );
  }

  core.setOutput('scan-id', totals.worst.id);
  core.setOutput('score', String(totals.worst.score));
  core.setOutput('passed', String(totals.passed));
  core.setOutput('violations-critical', String(totals.counts.critical));
  core.setOutput('violations-high', String(totals.counts.high));
  core.setOutput('violations-medium', String(totals.counts.medium));
  core.setOutput('violations-low', String(totals.counts.low));
  core.setOutput('total-issues', String(totals.totalIssues));
  core.setOutput('manual-review-count', String(totals.manualReviewCount));
  core.setOutput('engines-used', totals.engines.join(','));
  core.setOutput('warnings-count', String(totals.blocking.length));
  core.setOutput(
    'report-url',
    totals.worst.id ? `${config.reportDomain}/report/${totals.worst.id}` : ''
  );
  // Plan state, when the caller authenticated. Left empty for anonymous
  // runs rather than zero: there is no account to report against, and a
  // 0 would read as "no allowance left".
  const quota = totals.stats.find((s) => s.quota)?.quota || null;
  core.setOutput('plan-tier', quota?.tier ?? '');
  core.setOutput(
    'ci-scans-remaining',
    quota && !quota.unlimited && quota.ci_scans_remaining != null
      ? String(quota.ci_scans_remaining)
      : ''
  );
  if (quota) core.info(quotaLine(quota));

  core.appendSummary(
    renderSummary(results, {
      reportDomain: config.reportDomain,
      topIssues: config.topIssues,
    })
  );

  // An unrepresentative scan is not a pass. A bot challenge, consent
  // wall or HTTP block means the engines analysed an interstitial, and
  // a near-clean result on one of those says nothing about the site.
  // `fail-on: none` opts out along with every other gate.
  const unrepresentative =
    config.failOnUnrepresentative &&
    config.failOn !== 'none' &&
    totals.blocking.length > 0;

  const failed = !totals.passed || unrepresentative || unscanned.length > 0;

  if (config.annotations) emitAnnotations(results, { failed });

  const event = readEvent();
  const prNumber = pullRequestNumber(event);
  if (config.commentMode !== 'off' && prNumber) {
    if (!config.githubToken) {
      core.warning(
        'No `github-token` available, so the PR comment was skipped. Results ' +
          'are in the job summary.'
      );
    } else {
      // A malformed GITHUB_REPOSITORY is a commenting problem, not a
      // reason to turn a green scan red.
      let repo;
      try {
        repo = repository();
      } catch (err) {
        core.warning(`${err.message} Skipping the PR comment.`);
        repo = null;
      }
      if (repo) {
        await upsertComment({
          repo,
          prNumber,
          token: config.githubToken,
          mode: config.commentMode,
          body: renderComment(results, {
            reportDomain: config.reportDomain,
            topIssues: config.topIssues,
            failed,
            context: { sha: process.env.GITHUB_SHA || '' },
          }),
        });
      }
    }
  } else if (config.commentMode !== 'off') {
    core.debug('Not a pull request event; skipping the comment.');
  }

  if (unscanned.length > 0) {
    core.setFailed(
      `${unscanned.length} of ${config.urls.length} URLs could not be scanned: ` +
        unscanned.map((u) => `${u.url} (${u.message})`).join('; ') +
        '. Results for the URLs that did scan are in the job summary.'
    );
    return;
  }
  if (unrepresentative) {
    const kinds = [...new Set(totals.blocking.map(warningKind))].join(', ');
    core.setFailed(
      `The scan did not produce a trustworthy result (${kinds}). Findings and ` +
        'score may describe an interstitial rather than your page, so this is ' +
        'reported as a failure rather than a pass. Set ' +
        '`fail-on-unrepresentative: false` to treat it as advisory.'
    );
    return;
  }
  if (!totals.passed) {
    const reasons = totals.stats
      .filter((s) => !s.passed)
      .map((s) => `${s.url}: ${s.failReason.replace(/^FAILED:\s*/, '') || 'gate failed'}`)
      .join('; ');
    core.setFailed(
      `Accessibility gate failed. ${reasons}. ` +
        (totals.worst.id
          ? `Copy-as-PR fixes: ${config.reportDomain}/report/${totals.worst.id}#ai-fixes`
          : '')
    );
    return;
  }

  core.info(
    `Accessibility gate passed for ${results.length} URL${results.length === 1 ? '' : 's'}.`
  );
}

main().catch((err) => {
  // Configuration and infrastructure failures are called out as such.
  // A red build that reads "3 critical violations" when the real cause
  // was a gateway timeout sends the reviewer hunting for a regression
  // that does not exist.
  if (err?.status) {
    // A rate limit, a rejected token, a blocked URL: the message is the
    // whole story and a stack trace would only bury it.
    core.setFailed(`Accessibility Pro could not complete the scan: ${err.message}`);
    return;
  }
  core.setFailed(`Accessibility Pro Scan failed: ${err?.message || err}`);
  if (err?.stack) core.debug(err.stack);
});
