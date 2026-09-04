/**
 * End-to-end tests for the Accessibility Pro action.
 *
 * Run with `node test/e2e.mjs`. No test runner and no dependencies:
 * this file stands up a mock backend and a mock GitHub API, spawns
 * `src/main.mjs` as a real child process with an Actions-shaped
 * environment, and asserts on the four things a consumer actually
 * experiences - the exit code, the values written to $GITHUB_OUTPUT,
 * the job-summary markdown, and the exact comment body posted.
 *
 * Scenario 5 is the one worth reading first: a backend that reports
 * `passed: true` with a wall warning must still fail the build, because
 * a clean score on a bot-detection interstitial is not a clean site.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Defaults to the repository this file ships in, so `node test/e2e.mjs`
// just works; an explicit path is accepted for local experiments.
const ACTION = process.argv[2] || fileURLToPath(new URL('..', import.meta.url));

let scenario = {};
const captured = { comments: [], patches: [], scanBodies: [] };

const backend = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const body = Buffer.concat(chunks).toString('utf8');

    // --- mock GitHub API ---
    if (req.url.match(/\/issues\/comments\/\d+$/) && req.method === 'PATCH') {
      captured.patches.push(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 1 }));
      return;
    }
    if (req.url.includes('/issues/') && req.url.includes('/comments')) {
      if (req.method === 'GET') {
        res.writeHead(scenario.commentListStatus ?? 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(scenario.existingComments ?? []));
        return;
      }
      captured.comments.push(JSON.parse(body));
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 1 }));
      return;
    }
    // --- mock scan endpoint ---
    if (req.url === '/api/ci/scan') {
      const parsed = JSON.parse(body);
      captured.scanBodies.push({ payload: parsed, headers: req.headers });
      if (scenario.failFor && parsed.url.includes(scenario.failFor)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ detail: 'URL blocked: host is not reachable' }));
        return;
      }
      if (scenario.status === 402) {
        res.writeHead(402, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ detail: 'Monthly CI scan allowance exhausted (1000/1000 on the starter plan). It resets at your next billing cycle. Upgrade at https://www.accessibilitypro.app/pricing' }));
        return;
      }
      if (scenario.status === 429) {
        res.writeHead(429, { 'retry-after': '3600', 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Rate limit exceeded', retry_after: 3600 }));
        return;
      }
      if (scenario.delayMs) await new Promise((r) => setTimeout(r, scenario.delayMs));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(scenario.response(parsed.url)));
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });
});

await new Promise((r) => backend.listen(0, '127.0.0.1', r));
const port = backend.address().port;
const base = `http://127.0.0.1:${port}`;

function scanResult(url, overrides = {}) {
  return {
    id: overrides.id ?? '11111111-2222-3333-4444-555555555555',
    scan_id: overrides.id ?? '11111111-2222-3333-4444-555555555555',
    url,
    wcag_level: 'AA',
    passed: overrides.passed ?? true,
    exit_code: overrides.passed === false ? 1 : 0,
    score: overrides.score ?? 92,
    scan_duration_ms: 41000,
    engines_run: ['axe-core', 'pa11y', 'lighthouse'],
    issues: overrides.issues ?? [],
    manual_review: overrides.manual_review ?? [],
    warnings: overrides.warnings ?? [],
    summary_text: overrides.summary_text ?? (overrides.passed === false ? 'FAILED: critical violations (2) exceed threshold (0)' : 'PASSED'),
    gate_excluded_framework_managed: overrides.gateExcluded ?? 0,
    truncation: overrides.truncation ?? undefined,
    summary: {
      total_issues: (overrides.issues ?? []).length,
      manual_review_count: (overrides.manual_review ?? []).length,
      severity_counts: overrides.counts ?? { critical: 0, high: 0, medium: 0, low: 0 },
      engines_used: ['axe-core', 'pa11y', 'lighthouse'],
      tested_criteria: [],
      coverage: [],
      status_text: 'PASSED',
    },
    report_url: '/report/11111111-2222-3333-4444-555555555555',
  };
}

const RICH_ISSUE = {
  id: 'aria_70',
  rule_id: 'color-contrast',
  dedup_key: 'color-contrast:1.4.3:.btn',
  title: 'Text has insufficient contrast — em dash test',
  description: 'Element has insufficient colour contrast of 2.79:1 | pipe test <b>html</b>',
  severity: 'critical',
  wcag: '1.4.3',
  source_engine: 'axe-core',
  evidence_level: 'pixel-verified',
  confidence_bucket: 'high',
  legal_risk_tier: 1,
  impact_score: 88,
  occurrences: 9,
  occurrence_selectors: ['.btn.primary', '.btn.secondary'],
  location: '.btn.primary',
  element_tag: 'button',
  accessible_name: 'Sign up',
  contrast_ratio: 2.79,
  contrast_required: 4.5,
  fixability_minutes: 5,
  help_url: 'https://dequeuniversity.com/rules/axe/4.10/color-contrast',
  llm_rationale: 'The button label fails at 2.79:1 against its background.',
  llm_rationale_source: 'claude',
};

const FRAMEWORK_ISSUE = {
  id: 'x2',
  rule_id: 'aria-valid-attr-value',
  title: 'aria-controls | points to <missing> element',
  description: 'Portal id | is created at <b>open</b> time.',
  severity: 'high',
  wcag: '4.1.2',
  source_engine: 'axe-core',
  evidence_level: 'single-engine',
  confidence_bucket: 'medium',
  impact_score: 40,
  framework_managed: 'radix-portal',
  framework_name: 'Radix',
  location: '[aria-controls="radix-:r7:"]',
};

function run(env, { inputs }) {
  const dir = mkdtempSync(join(tmpdir(), 'apscan-'));
  const outputFile = join(dir, 'output.txt');
  const summaryFile = join(dir, 'summary.md');
  const eventFile = join(dir, 'event.json');
  writeFileSync(outputFile, '');
  writeFileSync(summaryFile, '');
  writeFileSync(eventFile, JSON.stringify({ pull_request: { number: 42 } }));

  const childEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    GITHUB_EVENT_PATH: eventFile,
    GITHUB_REPOSITORY: 'acme/widgets',
    GITHUB_SHA: 'abcdef1234567890',
    GITHUB_API_URL: base,
    GITHUB_ACTION_REF: 'v2',
    INPUT_URL: inputs.url,
    'INPUT_BACKEND-URL': base,
    'INPUT_REPORT-DOMAIN': 'https://www.accessibilitypro.app',
    'INPUT_GITHUB-TOKEN': 'ghs_faketoken',
    ...env,
  };

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ACTION, 'src', 'main.mjs')], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      const outputs = {};
      const raw = readFileSync(outputFile, 'utf8').split('\n');
      for (let i = 0; i < raw.length; i++) {
        const m = raw[i].match(/^([a-z-]+)<<(ghadelimiter_.+)$/);
        if (!m) continue;
        const lines = [];
        for (let j = i + 1; j < raw.length && raw[j] !== m[2]; j++) lines.push(raw[j]);
        outputs[m[1]] = lines.join('\n');
      }
      resolve({
        code,
        stdout,
        stderr,
        outputs,
        summary: readFileSync(summaryFile, 'utf8'),
        dir,
      });
    });
  });
}

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------- 1
console.log('\n[1] Clean scan, no findings');
scenario = { response: (u) => scanResult(u) };
captured.comments = [];
let r = await run({}, { inputs: { url: 'https://example.com' } });
check('exit 0', r.code === 0, `code=${r.code}\n${r.stderr}`);
check('passed output true', r.outputs.passed === 'true', JSON.stringify(r.outputs));
check('score output', r.outputs.score === '92');
check('report-url built', r.outputs['report-url'].endsWith('/report/11111111-2222-3333-4444-555555555555'));
check('summary rendered', r.summary.includes('✅ Passed') && r.summary.includes('No automatable WCAG AA violations'));
check('sticky comment posted', captured.comments.length === 1);
check('comment carries marker', (captured.comments[0]?.body || '').includes('<!-- accessibility-pro-action -->'));

// ---------------------------------------------------------------- 2
console.log('\n[2] Gate thresholds sent to backend, not recomputed');
check('thresholds in payload', JSON.stringify(captured.scanBodies.at(-1).payload.thresholds) === '{"critical":0,"high":0,"medium":1000000,"low":1000000}', JSON.stringify(captured.scanBodies.at(-1).payload));
check('wcag flags false for fail-on=error', captured.scanBodies.at(-1).payload.fail_on_wcag_a === false);
check('legacy repo header sent', captured.scanBodies.at(-1).headers['x-github-repository'] === 'acme/widgets');

// ---------------------------------------------------------------- 3
console.log('\n[3] fail-on: wcag maps to the criterion gate');
scenario = { response: (u) => scanResult(u) };
await run({ 'INPUT_FAIL-ON': 'wcag' }, { inputs: { url: 'https://example.com' } });
const wcagPayload = captured.scanBodies.at(-1).payload;
check('wcag A gate on', wcagPayload.fail_on_wcag_a === true);
check('wcag AA gate on', wcagPayload.fail_on_wcag_aa === true);
check('severity thresholds unlimited', wcagPayload.thresholds.critical === 1000000);

// ---------------------------------------------------------------- 4
console.log('\n[4] Backend says failed -> build fails, reason surfaced');
scenario = {
  response: (u) =>
    scanResult(u, {
      passed: false,
      score: 41,
      counts: { critical: 2, high: 1, medium: 0, low: 0 },
      issues: [RICH_ISSUE, FRAMEWORK_ISSUE],
      manual_review: [{ title: 'unverifiable' }],
      gateExcluded: 1,
      truncation: { hidden_count: 12, raw_count: 30, kept_count: 18 },
    }),
};
captured.comments = [];
r = await run({}, { inputs: { url: 'https://example.com' } });
check('exit 1', r.code === 1, `code=${r.code}`);
check('passed output false', r.outputs.passed === 'false');
check('critical count', r.outputs['violations-critical'] === '2');
check('manual review count', r.outputs['manual-review-count'] === '1');
check('fail reason in log', r.stdout.includes('exceed threshold') || r.stderr.includes('exceed threshold'), r.stdout.slice(-800));
const body4 = captured.comments[0]?.body || '';
check('comment shows failure headline', body4.includes('❌ Accessibility Pro: build gate failed'));
check('em dashes scrubbed', !body4.includes('—'), body4.match(/.{0,40}—.{0,40}/)?.[0]);
check('pipe escaped in title', body4.includes('\\|'));
check('html angle brackets escaped', body4.includes('&lt;b&gt;'));
check('evidence chip', body4.includes('pixel-verified'));
check('tier-1 chip', body4.includes('Tier-1 legal risk'));
check('contrast numbers', body4.includes('measured 2.79:1, required 4.5:1'));
check('element line', body4.includes('button "Sign up"'));
check('AI provenance label', body4.includes('_AI analysis:_'));
check('needs-review disclosure', body4.includes('#needs-review'));
check('framework exclusion disclosure', body4.includes('do not gate the build') || body4.includes('does not gate the build'));
check('truncation disclosure', body4.includes('12 repeat occurrences'));
check('annotations emitted', r.stdout.includes('::error title=') , r.stdout.slice(0, 400));

// ---------------------------------------------------------------- 5
console.log('\n[5] Wall warning: a clean score on an interstitial is not a pass');
scenario = {
  response: (u) =>
    scanResult(u, {
      passed: true,
      score: 96,
      warnings: [
        {
          kind: 'wall_detected',
          severity: 'warning',
          message: 'https://example.com appears to be showing a bot-detection challenge instead of its real content.',
        },
      ],
    }),
};
captured.comments = [];
r = await run({}, { inputs: { url: 'https://example.com' } });
check('exit 1 despite backend pass', r.code === 1, `code=${r.code}`);
check('warnings-count output', r.outputs['warnings-count'] === '1');
check('reason names the wall', r.stdout.includes('wall_detected') || r.stderr.includes('wall_detected'));
check('comment headline says not representative', (captured.comments[0]?.body || '').includes('not representative'));

// ---------------------------------------------------------------- 6
console.log('\n[6] fail-on-unrepresentative: false downgrades it to advisory');
r = await run({ 'INPUT_FAIL-ON-UNREPRESENTATIVE': 'false' }, { inputs: { url: 'https://example.com' } });
check('exit 0', r.code === 0, `code=${r.code}\n${r.stderr}`);
check('warning still rendered', r.summary.includes('may not reflect the real page'));

// ---------------------------------------------------------------- 7
console.log('\n[7] filter_chain_failed uses `type`, not `kind` — must still block');
scenario = {
  response: (u) =>
    scanResult(u, {
      warnings: [
        { type: 'filter_chain_failed', severity: 'warning', message: 'False-positive filtering did not complete on this scan.' },
      ],
    }),
};
r = await run({}, { inputs: { url: 'https://example.com' } });
check('exit 1', r.code === 1, `code=${r.code}`);
check('title resolved from `type`', r.summary.includes('False-positive filtering did not run'), r.summary.slice(0, 600));

// ---------------------------------------------------------------- 8
console.log('\n[8] claude_unavailable is info — must NOT block');
scenario = {
  response: (u) =>
    scanResult(u, {
      warnings: [{ kind: 'claude_unavailable', severity: 'info', message: 'AI rationale unavailable.' }],
    }),
};
r = await run({}, { inputs: { url: 'https://example.com' } });
check('exit 0', r.code === 0, `code=${r.code}\n${r.stderr}`);
check('info warning rendered', r.summary.includes('AI rationale and Copy-as-PR were unavailable'));

// ---------------------------------------------------------------- 9
console.log('\n[9] Multiple URLs in one step');
let n = 0;
scenario = {
  response: (u) => {
    n++;
    return scanResult(u, { id: `id-${n}`, score: n === 1 ? 88 : 55, counts: { critical: n, high: 0, medium: 0, low: 0 } });
  },
};
captured.comments = [];
r = await run({}, { inputs: { url: 'https://a.example.com\nhttps://b.example.com' } });
check('exit 0', r.code === 0, `code=${r.code}\n${r.stderr}`);
check('counts summed', r.outputs['violations-critical'] === '3', r.outputs['violations-critical']);
check('score is the worst', r.outputs.score === '55');
check('scan-id is the worst page', r.outputs['scan-id'] === 'id-2');
check('both URLs in the comment', (captured.comments[0]?.body || '').includes('a.example.com') && (captured.comments[0]?.body || '').includes('b.example.com'));

// --------------------------------------------------------------- 10
console.log('\n[10] SARIF + results file');
scenario = { response: (u) => scanResult(u, { issues: [RICH_ISSUE, FRAMEWORK_ISSUE], counts: { critical: 1, high: 1, medium: 0, low: 0 } }) };
const outDir = mkdtempSync(join(tmpdir(), 'apsarif-'));
r = await run(
  { 'INPUT_SARIF-FILE': join(outDir, 'a11y.sarif'), 'INPUT_RESULTS-FILE': join(outDir, 'raw.json') },
  { inputs: { url: 'https://example.com' } }
);
check('exit 0', r.code === 0, r.stderr);
const sarifPath = join(outDir, 'a11y.sarif');
check('sarif written', existsSync(sarifPath));
const sarif = JSON.parse(readFileSync(sarifPath, 'utf8'));
check('sarif version', sarif.version === '2.1.0');
check('one run', sarif.runs.length === 1);
check('rules deduped', sarif.runs[0].tool.driver.rules.length === 2);
check('critical maps to error', sarif.runs[0].results[0].level === 'error');
check('fingerprint uses dedup_key', sarif.runs[0].results[0].partialFingerprints.fingerprint === 'color-contrast:1.4.3:.btn');
check('region present for code scanning', sarif.runs[0].results[0].locations[0].physicalLocation.region.startLine === 1);
check('sarif-file output set', r.outputs['sarif-file'].endsWith('a11y.sarif'));
check('results file written', existsSync(join(outDir, 'raw.json')));

// --------------------------------------------------------------- 11
console.log('\n[11] Rate limit gives an actionable message, not a stack trace');
scenario = { status: 429, response: (u) => scanResult(u) };
r = await run({}, { inputs: { url: 'https://example.com' } });
check('exit 1', r.code === 1);
check('mentions quota + token remedy', r.stdout.includes('quota exhausted') && r.stdout.includes('accessibility-pro-token'), r.stdout.slice(-500));
check('no stack trace leaked', !r.stdout.includes('at async'));

// --------------------------------------------------------------- 12
console.log('\n[12] Sticky update reuses the existing comment');
scenario = {
  response: (u) => scanResult(u),
  existingComments: [{ id: 77, body: 'old <!-- accessibility-pro-action --> body' }],
};
captured.comments = [];
captured.patches = [];
r = await run({}, { inputs: { url: 'https://example.com' } });
check('patched not posted', captured.patches.length === 1 && captured.comments.length === 0, `patches=${captured.patches.length} posts=${captured.comments.length}`);
check('log says updated', r.stdout.includes('Updated the existing comment'));

// --------------------------------------------------------------- 13
console.log('\n[13] comment: off and legacy comment-on-pr: false');
captured.comments = [];
captured.patches = [];
scenario = { response: (u) => scanResult(u) };
await run({ INPUT_COMMENT: 'off' }, { inputs: { url: 'https://example.com' } });
check('no comment calls', captured.comments.length === 0 && captured.patches.length === 0);
r = await run({ 'INPUT_COMMENT-ON-PR': 'false' }, { inputs: { url: 'https://example.com' } });
check('legacy input honoured', captured.comments.length === 0 && captured.patches.length === 0);
check('deprecation warned', r.stdout.includes('deprecated'));

// --------------------------------------------------------------- 14
console.log('\n[14] Comment failure never turns a green scan red');
scenario = { response: (u) => scanResult(u), commentListStatus: 403 };
r = await run({}, { inputs: { url: 'https://example.com' } });
check('exit 0', r.code === 0, `code=${r.code}\n${r.stderr}`);
check('permission hint given', r.stdout.includes('pull-requests: write'));

// --------------------------------------------------------------- 15
console.log('\n[15] Input validation');
scenario = { response: (u) => scanResult(u) };
r = await run({ 'INPUT_WCAG-LEVEL': 'AAAA' }, { inputs: { url: 'https://example.com' } });
check('bad wcag-level rejected', r.code === 1 && r.stdout.includes("must be one of A, AA, AAA"));
r = await run({ INPUT_THRESHOLDS: '{"critical": -1}' }, { inputs: { url: 'https://example.com' } });
check('negative threshold rejected', r.code === 1 && r.stdout.includes('non-negative integer'));
r = await run({ INPUT_THRESHOLDS: '{"blocker": 1}' }, { inputs: { url: 'https://example.com' } });
check('unknown severity rejected', r.code === 1 && r.stdout.includes("Unknown severity 'blocker'"));
r = await run({ INPUT_THRESHOLDS: '{"critical": 3, "high": 5}' }, { inputs: { url: 'https://example.com' } });
check('custom thresholds forwarded', r.code === 0 && captured.scanBodies.at(-1).payload.thresholds.critical === 3 && captured.scanBodies.at(-1).payload.thresholds.high === 5, JSON.stringify(captured.scanBodies.at(-1)?.payload?.thresholds));
r = await run({ 'INPUT_TIMEOUT-MINUTES': '0' }, { inputs: { url: 'https://example.com' } });
check('bad timeout rejected', r.code === 1 && r.stdout.includes('between 1 and 60'));

// --------------------------------------------------------------- 16
console.log('\n[16] engines subset forwarded only when set');
scenario = { response: (u) => scanResult(u) };
await run({ INPUT_ENGINES: 'axe-core, pa11y' }, { inputs: { url: 'https://example.com' } });
check('engines array sent', JSON.stringify(captured.scanBodies.at(-1).payload.engines) === '["axe-core","pa11y"]');
await run({}, { inputs: { url: 'https://example.com' } });
check('engines omitted when blank', !('engines' in captured.scanBodies.at(-1).payload));

// --------------------------------------------------------------- 17
console.log('\n[17] Long-blocking response survives past undici’s 300s header cap');
scenario = { response: (u) => scanResult(u), delayMs: 1200 };
r = await run({}, { inputs: { url: 'https://example.com' } });
check('delayed response handled', r.code === 0, r.stderr);

// --------------------------------------------------------------- 18
console.log('\n[18] A response with no verdict is refused, not defaulted to pass');
scenario = {
  response: (u) => {
    const r = scanResult(u);
    delete r.passed;
    return r;
  },
};
r = await run({}, { inputs: { url: 'https://example.com' } });
check('exit 1', r.code === 1, `code=${r.code}`);
check('names the missing verdict', r.stdout.includes('no pass/fail verdict'), r.stdout.slice(-400));

// --------------------------------------------------------------- 19
console.log('\n[19] A URL containing a comma is one URL, not two');
scenario = { response: (u) => scanResult(u) };
captured.scanBodies.length = 0;
r = await run({}, { inputs: { url: 'https://example.com/search?ids=1,2,3' } });
check('exit 0', r.code === 0, r.stderr);
check('single scan issued', captured.scanBodies.length === 1, `count=${captured.scanBodies.length}`);
check('url intact', captured.scanBodies[0].payload.url === 'https://example.com/search?ids=1,2,3', captured.scanBodies[0]?.payload?.url);

// --------------------------------------------------------------- 20
console.log('\n[20] top-issues is validated, and caps the inline list');
r = await run({ 'INPUT_TOP-ISSUES': 'lots' }, { inputs: { url: 'https://example.com' } });
check('garbage rejected', r.code === 1 && r.stdout.includes('from 1 to 25'));
scenario = {
  response: (u) =>
    scanResult(u, {
      issues: Array.from({ length: 8 }, (_, i) => ({
        id: `i${i}`,
        title: `Finding ${i}`,
        severity: 'medium',
        wcag: '1.1.1',
        impact_score: 100 - i,
        source_engine: 'axe-core',
      })),
      counts: { critical: 0, high: 0, medium: 8, low: 0 },
    }),
};
r = await run({ 'INPUT_TOP-ISSUES': '2' }, { inputs: { url: 'https://example.com' } });
const listed = r.summary.match(/^\d+\. \*\*Finding/gm) || [];
check('lists exactly 2', listed.length === 2, listed.join(','));
check('says how many were omitted', r.summary.includes('6 further findings'), r.summary.slice(-900));
check('ranked by impact', r.summary.includes('Finding 0') && !r.summary.includes('Finding 7'));

// --------------------------------------------------------------- 21
console.log('\n[21] One bad URL in a multi-URL run does not discard the others');
let seen = 0;
scenario = {
  failFor: 'broken',
  response: (u) => scanResult(u, { id: `ok-${++seen}` }),
};
captured.comments = [];
r = await run({}, { inputs: { url: 'https://ok.example.com\nhttps://broken.example.com' } });
check('exit 1', r.code === 1, `code=${r.code}`);
check('names the unscanned URL', r.stdout.includes('broken.example.com'), r.stdout.slice(-500));
check('good URL still reported', r.summary.includes('ok.example.com'), r.summary.slice(0, 400));
check('good URL still commented', (captured.comments[0]?.body || '').includes('ok.example.com'));

// --------------------------------------------------------------- 22
console.log('\n[22] Every URL failing surfaces the error, not an empty summary');
scenario = { failFor: 'broken', response: (u) => scanResult(u) };
r = await run({}, { inputs: { url: 'https://broken.example.com' } });
check('exit 1', r.code === 1);
check('no empty scan summary written', !r.summary.includes('| Critical |'), r.summary);

// --------------------------------------------------------------- 23
console.log('\n[23] Authenticated run surfaces the plan allowance');
scenario = {
  response: (u) => ({
    ...scanResult(u),
    quota: {
      tier: 'professional',
      ci_scans_used: 120,
      ci_scans_limit: 5000,
      ci_scans_remaining: 4880,
      unlimited: false,
    },
  }),
};
captured.comments = [];
r = await run({ 'INPUT_ACCESSIBILITY-PRO-TOKEN': 'tok_abc' }, { inputs: { url: 'https://example.com' } });
check('exit 0', r.code === 0, r.stderr);
check('plan-tier output', r.outputs['plan-tier'] === 'professional', r.outputs['plan-tier']);
check('remaining output', r.outputs['ci-scans-remaining'] === '4880', r.outputs['ci-scans-remaining']);
check('bearer token sent', captured.scanBodies.at(-1).headers.authorization === 'Bearer tok_abc');
check('comment shows the plan', (captured.comments[0]?.body || '').includes('120 of 5000 CI scans used this month'), (captured.comments[0]?.body || '').slice(-300));
check('no warning below 90%', !(captured.comments[0]?.body || '').includes('CI scans used this month ⚠️'));

// --------------------------------------------------------------- 24
console.log('\n[24] Near the allowance, the comment warns');
scenario = {
  response: (u) => ({
    ...scanResult(u),
    quota: { tier: 'starter', ci_scans_used: 960, ci_scans_limit: 1000, ci_scans_remaining: 40, unlimited: false },
  }),
};
captured.comments = [];
await run({ 'INPUT_ACCESSIBILITY-PRO-TOKEN': 'tok_abc' }, { inputs: { url: 'https://example.com' } });
check('warning rendered at 96%', (captured.comments[0]?.body || '').includes('⚠️'), (captured.comments[0]?.body || '').slice(-300));

// --------------------------------------------------------------- 25
console.log('\n[25] Anonymous runs claim no allowance at all');
scenario = { response: (u) => scanResult(u) };
captured.comments = [];
r = await run({}, { inputs: { url: 'https://example.com' } });
check('plan-tier empty', r.outputs['plan-tier'] === '', JSON.stringify(r.outputs['plan-tier']));
check('remaining empty, not 0', r.outputs['ci-scans-remaining'] === '', JSON.stringify(r.outputs['ci-scans-remaining']));
check('no plan line in comment', !(captured.comments[0]?.body || '').includes('CI scans used'));

// --------------------------------------------------------------- 26
console.log('\n[26] Exhausted allowance is a distinct, actionable failure');
scenario = { status: 402, response: (u) => scanResult(u) };
r = await run({ 'INPUT_ACCESSIBILITY-PRO-TOKEN': 'tok_abc' }, { inputs: { url: 'https://example.com' } });
check('exit 1', r.code === 1);
check('quotes the backend message', r.stdout.includes('Monthly CI scan allowance exhausted'), r.stdout.slice(-400));
check('not confused with a rate limit', !r.stdout.includes('resets in about'));

backend.close();
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
