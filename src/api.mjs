/**
 * Accessibility Pro backend client.
 */

import { httpRequestWithRetry, parseJson, redirectHint, HttpError } from './http.mjs';
import * as core from './core.mjs';

/**
 * Stand-in for "no limit on this severity".
 *
 * The backend gate fails when `count > threshold`, so a large finite
 * number disables a bucket without needing a null-handling branch in
 * `evaluate_ci_gate`.
 */
const NO_CAP = 1_000_000;

/**
 * `fail-on` shorthands, expressed in the backend's own gate vocabulary.
 *
 * This is the most consequential change in v2. Until now the action
 * computed its own verdict from `severity_counts` while the backend
 * computed a different one in `evaluate_ci_gate`, and the two disagreed
 * by design: the backend excludes framework-managed findings
 * (reCAPTCHA, Turnstile, component-library portals, streaming-SSR
 * artifacts) and non-criterion best-practice rules from the build
 * verdict, because the host cannot fix those in their own code. The
 * hosted report said PASSED, the Action failed the build, and both were
 * describing the same scan.
 *
 * Sending thresholds instead of post-processing counts leaves exactly
 * one gate, and it lives next to the scoring code it has to agree with.
 */
const FAIL_ON_PRESETS = {
  error: {
    thresholds: { critical: 0, high: 0, medium: NO_CAP, low: NO_CAP },
    fail_on_wcag_a: false,
    fail_on_wcag_aa: false,
    describe: 'any critical or high-severity violation fails the build',
  },
  warning: {
    thresholds: { critical: 0, high: 0, medium: 0, low: NO_CAP },
    fail_on_wcag_a: false,
    fail_on_wcag_aa: false,
    describe: 'any medium-or-worse violation fails the build',
  },
  wcag: {
    thresholds: { critical: NO_CAP, high: NO_CAP, medium: NO_CAP, low: NO_CAP },
    fail_on_wcag_a: true,
    fail_on_wcag_aa: true,
    describe:
      'any failure of a Level A or AA success criterion fails the build, whatever its severity',
  },
  none: {
    thresholds: { critical: NO_CAP, high: NO_CAP, medium: NO_CAP, low: NO_CAP },
    fail_on_wcag_a: false,
    fail_on_wcag_aa: false,
    describe: 'report only, never fails the build',
  },
};

export const FAIL_ON_CHOICES = Object.keys(FAIL_ON_PRESETS);

/**
 * Resolve the gate the backend should apply.
 *
 * An explicit `thresholds` input wins over the `fail-on` shorthand:
 * a team paying down a backlog needs "fail if criticals exceed 3",
 * which no preset can express.
 */
export function resolveGate({ failOn, thresholdsJson }) {
  const preset = FAIL_ON_PRESETS[failOn];
  if (!preset) {
    throw new Error(
      `Input 'fail-on' must be one of ${FAIL_ON_CHOICES.join(', ')} (got '${failOn}').`
    );
  }
  const gate = {
    thresholds: { ...preset.thresholds },
    fail_on_wcag_a: preset.fail_on_wcag_a,
    fail_on_wcag_aa: preset.fail_on_wcag_aa,
    describe: preset.describe,
  };
  if (!thresholdsJson) return gate;

  let parsed;
  try {
    parsed = JSON.parse(thresholdsJson);
  } catch (err) {
    throw new Error(
      `Input 'thresholds' must be a JSON object like {"critical": 0, "high": 3}. ${err.message}`
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Input 'thresholds' must be a JSON object, not an array.`);
  }
  const allowed = ['critical', 'high', 'medium', 'low'];
  for (const [key, value] of Object.entries(parsed)) {
    if (!allowed.includes(key)) {
      throw new Error(
        `Unknown severity '${key}' in 'thresholds'. Allowed: ${allowed.join(', ')}.`
      );
    }
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(
        `Threshold '${key}' must be a non-negative integer (got ${JSON.stringify(value)}).`
      );
    }
    gate.thresholds[key] = value;
  }
  gate.describe =
    'custom thresholds - ' +
    allowed
      .map((k) => `${k}: ${gate.thresholds[k] >= NO_CAP ? 'unlimited' : gate.thresholds[k]}`)
      .join(', ');
  return gate;
}

/**
 * Mint a GitHub Actions OIDC token for the free-tier quota bucket.
 *
 * The backend prefers a signed `repository_id` claim over the spoofable
 * `X-GitHub-Repository` header (backend/services/platform/
 * github_oidc.py, which asks Action repos to migrate to this recipe).
 * Without a token, unrelated repositories sharing a GitHub-hosted
 * runner's NAT egress IP can be bucketed together and exhaust each
 * other's free quota.
 *
 * Best-effort: a workflow without `permissions: id-token: write` has no
 * request URL in its environment, which is not an error. The legacy
 * header keeps the scan working.
 */
export async function mintOidcToken(audience) {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !requestToken) {
    core.debug(
      'No OIDC request URL in the environment. Add `permissions: { id-token: write }` ' +
        'to bucket free-tier quota by verified repository instead of by runner IP.'
    );
    return null;
  }
  try {
    const res = await httpRequestWithRetry(
      `${url}&audience=${encodeURIComponent(audience)}`,
      {
        headers: {
          Authorization: `Bearer ${requestToken}`,
          Accept: 'application/json; api-version=2.0',
        },
        timeoutMs: 30_000,
        retries: 1,
        retryDelayMs: 2_000,
      }
    );
    if (res.status !== 200) {
      core.debug(`OIDC token request returned HTTP ${res.status}; skipping.`);
      return null;
    }
    const token = parseJson(res, 'OIDC token request').value;
    if (token) core.setSecret(token);
    return token || null;
  } catch (err) {
    core.debug(`OIDC token request failed (${err.message}); skipping.`);
    return null;
  }
}

/**
 * Rewrite em dashes to a spaced hyphen, everywhere in a response tree.
 *
 * Mirrors `src/lib/utils/text.ts`. The hosted report gets this from
 * `GET /api/scans/{id}`, which scrubs at that read boundary, but
 * `POST /api/ci/scan` returns the live result without passing through
 * it - so PR comments were the one surface still showing raw engine
 * text. En dashes (U+2013) survive so numeric ranges stay intact.
 */
export function stripEmDashesDeep(value) {
  if (typeof value === 'string') return value.replace(/ ?[—―] ?/g, ' - ');
  if (Array.isArray(value)) return value.map(stripEmDashesDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = stripEmDashesDeep(v);
    return out;
  }
  return value;
}

/** Run one scan. Resolves to the full `/api/ci/scan` payload. */
export async function runScan({
  backendUrl,
  url,
  wcagLevel,
  gate,
  engines,
  token,
  oidcToken,
  timeoutMs,
  retries,
}) {
  const endpoint = `${backendUrl}/api/ci/scan`;
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'accessibility-pro-action',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (oidcToken) headers['X-GitHub-OIDC-Token'] = oidcToken;
  // Legacy bucket, kept for backends that predate OIDC verification and
  // for the case where the token request failed.
  if (process.env.GITHUB_REPOSITORY) {
    headers['X-GitHub-Repository'] = process.env.GITHUB_REPOSITORY;
  }

  const payload = {
    url,
    wcag_level: wcagLevel,
    thresholds: gate.thresholds,
    fail_on_wcag_a: gate.fail_on_wcag_a,
    fail_on_wcag_aa: gate.fail_on_wcag_aa,
    source: 'github-action',
    runner: `accessibility-pro/action@${process.env.GITHUB_ACTION_REF || 'v2'}`,
  };
  if (engines.length) payload.engines = engines;

  const res = await httpRequestWithRetry(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    timeoutMs,
    retries,
    onRetry: (attempt, reason) =>
      core.warning(
        `Scan attempt ${attempt} failed (${reason}). Retrying in 30s. ` +
          'This is a backend availability problem, not an accessibility finding.'
      ),
  });

  if (res.status === 429) {
    const retryAfter = Number(res.headers['retry-after']) || 3600;
    throw new HttpError(
      'Scan quota exhausted for this repository. The free tier allows 10 scans ' +
        `per day and 10 per hour; the quota resets in about ${Math.ceil(retryAfter / 60)} ` +
        'minutes. Supply `accessibility-pro-token` to scan against your plan quota instead.',
      { status: 429 }
    );
  }
  if (res.status === 400) {
    throw new HttpError(
      `The backend rejected ${url}: ${safeDetail(res.body)}. Public URLs only - ` +
        'the scanner blocks private and link-local addresses.',
      { status: 400 }
    );
  }
  if (res.status === 402) {
    // The plan's CI allowance is spent. Distinct from 429, which is the
    // free tier's rate limit: this one does not clear in an hour.
    throw new HttpError(safeDetail(res.body), { status: 402 });
  }
  if (res.status === 401 || res.status === 403) {
    throw new HttpError(
      `The supplied accessibility-pro-token was rejected (HTTP ${res.status}). ` +
        'Check the secret, or remove it to scan on the free tier.',
      { status: res.status }
    );
  }
  if (res.status === 504) {
    throw new HttpError(
      `The scan of ${url} exceeded the backend wall clock. The page loaded but ` +
        'analysis did not finish, so this is neither a pass nor a set of findings.',
      { status: 504 }
    );
  }
  if (res.status >= 300 && res.status < 400) {
    throw new HttpError(
      `The backend at ${backendUrl} redirected the scan request (HTTP ` +
        `${res.status}).${redirectHint(res)}`,
      { status: res.status }
    );
  }
  if (res.status < 200 || res.status >= 300) {
    throw new HttpError(
      `Scan request failed: HTTP ${res.status}. ${safeDetail(res.body)}`,
      { status: res.status }
    );
  }

  return stripEmDashesDeep(parseJson(res, 'Scan request'));
}

/** Pull a human message out of an error body without dumping raw HTML. */
function safeDetail(body) {
  try {
    const parsed = JSON.parse(body);
    const detail = parsed.detail ?? parsed.error ?? parsed.message;
    if (typeof detail === 'string') return detail;
    if (detail && typeof detail === 'object') {
      return detail.message
        ? `${detail.message}${detail.correlation_id ? ` (correlation id ${detail.correlation_id})` : ''}`
        : JSON.stringify(detail);
    }
  } catch {
    /* fall through to the raw slice */
  }
  return body.slice(0, 300).replace(/\s+/g, ' ').trim() || '(empty response body)';
}
