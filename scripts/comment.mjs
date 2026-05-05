#!/usr/bin/env node
/**
 * Post a PR comment with the impact-ranked top-5 issues + a deep link
 * that opens "Copy as PR" in the hosted report.
 *
 * Uses the GitHub REST API directly (via fetch + GITHUB_TOKEN) to keep
 * the action dep-free AND to avoid shell interpretation of any
 * user-influenced fields.
 */

import { readFile } from 'node:fs/promises';

const {
  INPUT_SCAN_ID,
  INPUT_BACKEND_URL = 'https://access-pro-ai-production.up.railway.app',
  INPUT_REPORT_DOMAIN = 'https://www.accessibilitypro.app',
  INPUT_URL,
  GITHUB_REPOSITORY,
  GITHUB_EVENT_PATH,
  GH_TOKEN,
  GITHUB_TOKEN
} = process.env;

if (!INPUT_SCAN_ID) {
  console.log('No scan-id; skipping PR comment.');
  process.exit(0);
}

const token = GH_TOKEN || GITHUB_TOKEN;
if (!token) {
  console.log('No GH_TOKEN/GITHUB_TOKEN in environment; skipping PR comment.');
  process.exit(0);
}

const BACKEND = INPUT_BACKEND_URL.replace(/\/+$/, '');
const REPORT_DOMAIN = INPUT_REPORT_DOMAIN.replace(/\/+$/, '');

async function main() {
  const event = JSON.parse(await readFile(GITHUB_EVENT_PATH, 'utf8'));
  const prNumber = event?.pull_request?.number;
  if (!prNumber) {
    console.log('Not a pull_request event; skipping.');
    return;
  }

  const scan = await fetchScan();
  if (!scan) return;

  const body = renderBody(scan);
  await postComment(prNumber, body);
  console.log(`Posted PR comment on #${prNumber}.`);
}

async function fetchScan() {
  const res = await fetch(`${BACKEND}/api/scans/${INPUT_SCAN_ID}`);
  if (!res.ok) {
    console.log(`Could not fetch scan (${res.status}); skipping PR comment.`);
    return null;
  }
  return res.json();
}

function renderBody(scan) {
  const issues = [...(scan.issues || [])]
    .sort((a, b) => (b.impact_score ?? 0) - (a.impact_score ?? 0))
    .slice(0, 5);

  const reportUrl = `${REPORT_DOMAIN}/report/${scan.id}`;
  const score = Math.round(scan.score ?? 0);

  const lines = [
    `## Accessibility Pro — score **${score}/100**`,
    '',
    `**URL:** ${INPUT_URL}`,
    '',
    issues.length === 0
      ? 'No automatable WCAG 2.2 AA violations detected. ✅'
      : '### Top issues (ranked by impact)',
    '',
    ...issues.map((i, idx) => {
      const tier = i.legal_risk_tier === 1 ? ' · **Tier-1 legal risk**' : '';
      const conf = i.confidence_bucket ? ` · ${i.confidence_bucket} confidence` : '';
      return `${idx + 1}. **${i.title}** (${i.severity}${tier}${conf}) — WCAG ${i.wcag}`;
    }),
    '',
    `**[View full report and Copy-as-PR fixes →](${reportUrl}#ai-fixes)**`,
    '',
    '<sub>Every patch emitted from that link is sandbox-validated: applied to ' +
      'the captured DOM, re-scanned, and only labeled Verified when it resolves ' +
      'the violation with zero regressions.</sub>'
  ];
  return lines.join('\n');
}

async function postComment(prNumber, body) {
  // Direct REST call — no shell, no argv interpolation of user-controlled
  // fields. `GITHUB_REPOSITORY` is set by GitHub itself, but we still
  // validate its shape before splicing it into a URL path.
  if (!/^[\w.-]+\/[\w.-]+$/.test(GITHUB_REPOSITORY || '')) {
    throw new Error(`Unexpected GITHUB_REPOSITORY value: ${GITHUB_REPOSITORY}`);
  }
  const url = `https://api.github.com/repos/${GITHUB_REPOSITORY}/issues/${prNumber}/comments`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'accessibility-pro-action'
    },
    body: JSON.stringify({ body })
  });
  if (!res.ok) {
    throw new Error(`GitHub comment API failed: ${res.status} ${await res.text()}`);
  }
}

main().catch((err) => {
  console.error(`Comment failed: ${err.stack || err.message}`);
  // Non-fatal — a failed comment shouldn't break the scan result.
  process.exit(0);
});
