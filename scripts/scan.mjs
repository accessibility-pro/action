#!/usr/bin/env node
/**
 * Accessibility Pro GitHub Action — scan script.
 *
 * POSTs /api/ci/scan with the target URL + WCAG level, exports the
 * scan metadata as action outputs, and exits non-zero when the
 * `fail-on` threshold is breached.
 *
 * Environment (provided by action.yml):
 *   INPUT_URL
 *   INPUT_WCAG_LEVEL     — A | AA | AAA
 *   INPUT_FAIL_ON        — error | warning | none
 *   INPUT_TOKEN          — optional; unlocks Team quota + Copy-as-PR
 *   INPUT_BACKEND_URL    — backend base url
 *   INPUT_REPORT_DOMAIN  — hosted-report origin (e.g. accessibilitypro.app)
 */

import { appendFileSync } from 'node:fs';

const {
  INPUT_URL,
  INPUT_WCAG_LEVEL = 'AA',
  INPUT_FAIL_ON = 'error',
  INPUT_TOKEN = '',
  INPUT_BACKEND_URL = 'https://access-pro-ai-production.up.railway.app',
  INPUT_REPORT_DOMAIN = 'https://www.accessibilitypro.app',
  GITHUB_OUTPUT
} = process.env;

if (!INPUT_URL) {
  console.error('::error::`url` input is required');
  process.exit(1);
}

// Normalise trailing slashes once so we don't accidentally produce
// `//` mid-URL later. Both `api/ci/scan` and `report/<id>` use this.
const BACKEND = INPUT_BACKEND_URL.replace(/\/+$/, '');
const REPORT_DOMAIN = INPUT_REPORT_DOMAIN.replace(/\/+$/, '');

function setOutput(key, value) {
  if (!GITHUB_OUTPUT) return;
  appendFileSync(GITHUB_OUTPUT, `${key}=${value}\n`, 'utf8');
}

async function main() {
  const endpoint = `${BACKEND}/api/ci/scan`;
  const headers = { 'Content-Type': 'application/json' };
  if (INPUT_TOKEN) headers['Authorization'] = `Bearer ${INPUT_TOKEN}`;

  const body = JSON.stringify({
    url: INPUT_URL,
    wcag_level: INPUT_WCAG_LEVEL,
    source: 'github-action',
    runner: 'accessibility-pro/action'
  });

  console.log(`::group::Requesting scan for ${INPUT_URL}`);
  console.log(`POST ${endpoint}`);
  const res = await fetch(endpoint, { method: 'POST', headers, body });
  console.log(`::endgroup::`);

  if (res.status === 429) {
    console.error(
      '::error::Rate limit reached. Add an `accessibility-pro-token` to ' +
        `unlock Team-quota scans: ${REPORT_DOMAIN}/pricing`
    );
    process.exit(1);
  }

  if (!res.ok) {
    console.error(`::error::Scan failed: HTTP ${res.status}`);
    console.error(await res.text());
    process.exit(1);
  }

  const scan = await res.json();
  const summary = scan.summary || {};
  const severityCounts = summary.severity_counts || countBySeverity(scan.issues || []);
  const score = typeof scan.score === 'number' ? scan.score : 0;
  const reportUrl = scan.id ? `${REPORT_DOMAIN}/report/${scan.id}` : '';

  setOutput('scan-id', scan.id || '');
  setOutput('score', String(Math.round(score)));
  setOutput('violations-critical', String(severityCounts.critical || 0));
  setOutput('violations-high', String(severityCounts.high || 0));
  setOutput('report-url', reportUrl);

  // Compact step-summary on the GitHub run page. Markdown-rendered.
  const ghSummary = process.env.GITHUB_STEP_SUMMARY;
  if (ghSummary) {
    appendFileSync(
      ghSummary,
      `## Accessibility Pro scan · ${INPUT_URL}\n\n` +
        `**Score:** ${Math.round(score)}/100\n\n` +
        `| Severity | Count |\n` +
        `|---|---|\n` +
        `| Critical | ${severityCounts.critical || 0} |\n` +
        `| High | ${severityCounts.high || 0} |\n` +
        `| Medium | ${severityCounts.medium || 0} |\n` +
        `| Low | ${severityCounts.low || 0} |\n\n` +
        (reportUrl
          ? `[View full report →](${reportUrl})\n\n` +
            `[Copy-as-PR fixes →](${reportUrl}#ai-fixes)\n`
          : ''),
      'utf8'
    );
  }

  // Enforce fail-on threshold.
  const critical = Number(severityCounts.critical || 0);
  const high = Number(severityCounts.high || 0);
  const medium = Number(severityCounts.medium || 0);

  if (INPUT_FAIL_ON === 'error' && critical + high > 0) {
    console.error(
      `::error::${critical} critical + ${high} high-severity violations ` +
        `(fail-on: error). ` +
        (reportUrl ? `Copy-as-PR fixes: ${reportUrl}#ai-fixes` : '')
    );
    process.exit(1);
  }
  if (INPUT_FAIL_ON === 'warning' && critical + high + medium > 0) {
    console.error(
      `::error::${critical + high + medium} violations at warning or higher (fail-on: warning).`
    );
    process.exit(1);
  }

  console.log(`Scan complete. Score: ${Math.round(score)}. Scan id: ${scan.id}`);
}

function countBySeverity(issues) {
  const out = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const i of issues || []) out[i.severity] = (out[i.severity] || 0) + 1;
  return out;
}

main().catch((err) => {
  console.error(`::error::${err.stack || err.message}`);
  process.exit(1);
});
