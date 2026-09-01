/**
 * HTTP client for the action.
 *
 * Deliberately NOT `fetch`. `/api/ci/scan` is a synchronous
 * long-blocking endpoint: the response is held open until the whole
 * multi-engine scan (axe-core, Lighthouse, pa11y, IBM Equal Access,
 * arc-style, plus the live-DOM verifiers) finishes. Node's built-in
 * fetch is undici, whose `headersTimeout` defaults to 300s and cannot
 * be raised without constructing an `undici.Agent` - a dependency this
 * action does not carry.
 *
 * That default is not theoretical. The same 300s cap fired on our own
 * dogfood runs against a heavy SPA (5min 1sec wall, UND_ERR_HEADERS_
 * TIMEOUT), and because the throw was unhandled Node exited 1 - which
 * a reviewer reads as "the accessibility gate failed" rather than "the
 * request timed out". `node:http`/`node:https` impose no header
 * deadline of their own, so the budget below is the only one.
 */

import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';

/** Response bodies larger than this are a bug, not a big scan. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/**
 * Backend / gateway statuses worth one more attempt.
 *
 * 429 is deliberately absent: the quota reset is an hour away
 * (`Retry-After: 3600`), so a 30-second retry only burns runner minutes
 * before reporting the same thing. `api.mjs` answers it directly.
 */
const TRANSIENT_STATUSES = new Set([408, 425, 500, 502, 503, 504]);

/**
 * Network-layer error codes that mean "try again", as opposed to a
 * misconfiguration (ENOTFOUND on a typo'd backend-url is retried too;
 * one wasted retry is cheaper than telling a user with flaky DNS that
 * their backend does not exist).
 */
const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN',
  'ENOTFOUND', 'ERR_SOCKET_CONNECTION_TIMEOUT', 'UND_ERR_SOCKET',
]);

export class HttpError extends Error {
  constructor(message, { status, body, code } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.code = code;
  }
}

function requestOnce(url, { method, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new HttpError(`Malformed URL: ${url}`, { code: 'ERR_INVALID_URL' }));
      return;
    }
    const isHttps = target.protocol === 'https:';
    if (!isHttps && target.protocol !== 'http:') {
      reject(
        new HttpError(`Unsupported protocol: ${target.protocol}`, {
          code: 'ERR_INVALID_PROTOCOL',
        })
      );
      return;
    }
    const send = isHttps ? httpsRequest : httpRequest;

    const req = send(
      target,
      {
        method,
        headers: {
          // No compression: we do not carry a decompressor, and a proxy
          // that gzips an un-negotiated response would hand us bytes we
          // cannot parse.
          'Accept-Encoding': 'identity',
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_BODY_BYTES) {
            req.destroy();
            reject(
              new HttpError('Response body exceeded 64 MB', {
                status: res.statusCode,
                code: 'ERR_BODY_TOO_LARGE',
              })
            );
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        );
        res.on('error', (err) =>
          reject(new HttpError(err.message, { code: err.code || 'ERR_STREAM' }))
        );
      }
    );

    // Inactivity budget. A scan that sends nothing at all for this long
    // is hung; the retry loop above decides whether to try again.
    req.setTimeout(timeoutMs, () => {
      req.destroy(
        new HttpError(
          `No response within ${Math.round(timeoutMs / 1000)}s`,
          { code: 'ETIMEDOUT' }
        )
      );
    });
    req.on('error', (err) =>
      reject(
        err instanceof HttpError
          ? err
          : new HttpError(err.message, { code: err.code || err.name })
      )
    );
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Perform a request, retrying transient failures.
 *
 * `onRetry(attempt, reason)` lets the caller narrate the wait; CI logs
 * that go quiet for minutes read as a hang.
 */
export async function httpRequestWithRetry(
  url,
  { method = 'GET', headers = {}, body, timeoutMs = 15 * 60 * 1000, retries = 1, retryDelayMs = 30_000, onRetry } = {}
) {
  const attempts = Math.max(1, retries + 1);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await requestOnce(url, { method, headers, body, timeoutMs });
      if (res.status < 500 && !TRANSIENT_STATUSES.has(res.status)) return res;
      if (attempt === attempts) return res;
      onRetry?.(attempt, `HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
      const code = err.code || err.name || 'unknown';
      if (attempt === attempts || !TRANSIENT_CODES.has(code)) throw err;
      onRetry?.(attempt, `${code}: ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, retryDelayMs));
  }
  throw lastError ?? new HttpError('Request failed');
}

/**
 * Describe a redirect the client deliberately did not follow.
 *
 * Following a 3xx on a POST means re-sending the body to a host the
 * caller did not name, so the answer is to tell them where it pointed
 * and let them fix the URL.
 */
export function redirectHint(res) {
  const location = res.headers?.location;
  return location
    ? ` The server redirected to ${location}; set backend-url to that address.`
    : ' The server sent a redirect with no Location header.';
}

/** Parse a JSON response body, preserving the raw text on failure. */
export function parseJson(res, context) {
  try {
    return JSON.parse(res.body);
  } catch {
    throw new HttpError(
      `${context} returned HTTP ${res.status} with a non-JSON body: ` +
        `${res.body.slice(0, 300)}`,
      { status: res.status, body: res.body }
    );
  }
}
