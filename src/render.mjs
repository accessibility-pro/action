/**
 * Markdown rendering for the PR comment and the job summary.
 *
 * Both surfaces read the same scan payload, so they share one renderer
 * and differ only in framing. Everything here is derived from the
 * `POST /api/ci/scan` response - the action never re-fetches the scan,
 * which is why fields the public read endpoint strips (manual_review,
 * warnings, truncation, gate exclusions) can be shown at all.
 */

/**
 * Human labels for `evidence_level`, stamped by
 * backend/services/filtering/evidence.py after dedup. Mirrors
 * `src/lib/report/evidence.ts`; the action is dependency-free, so the
 * map is duplicated here on purpose. Keep the two in sync.
 */
const EVIDENCE_LABELS = {
  'interaction-verified': 'verified by interaction',
  'pixel-verified': 'pixel-verified',
  'dom-confirmed': 'DOM-confirmed',
  'multi-engine': 'multi-engine',
  'single-engine': 'single engine',
  contradicted: 'contradicted',
};

/** Headline copy per scan-warning kind, mirroring the report banner. */
const WARNING_TITLES = {
  wall_detected: 'This scan may not reflect the real page',
  http_blocked: 'The site returned an HTTP block',
  bot_challenge: 'The site served a bot-detection challenge',
  consent_wall: 'The site served a full-page consent dialog',
  filter_chain_failed: 'False-positive filtering did not run',
  enrichment_timeout: 'Confidence scoring did not finish',
  enrichment_failed: 'Confidence scoring failed',
  claude_unavailable: 'AI rationale and Copy-as-PR were unavailable',
  llm_partial_fallback: 'Some rationales fell back to rule templates',
  // Trustworthy kinds, so they never gate a build — but a run that
  // says "Scan notice" three times tells a reader nothing. These four
  // are the ones the report has always titled and the action did not.
  time_budget: 'The scan reached its time budget',
  language_variants_sampled: 'Other language versions were sampled, not scanned in full',
  probe_budget_adapted: 'Keyboard probing was reduced on slow pages',
  consent_not_dismissed: 'A cookie banner stayed up on some pages',
  // The gate is stricter than the owner asked for, never looser, so this
  // is not an unrepresentative scan; it explains a red build on a
  // finding someone already dismissed.
  dismissals_unavailable: 'Your saved dismissals could not be applied',
};

/**
 * Warning kinds that make a green result untrustworthy.
 *
 * A bot challenge, a consent wall or an HTTP block means the scanner
 * never saw the page, so a near-clean result says nothing about the
 * site. A skipped filter chain means the findings are raw engine output
 * that the pipeline would normally have pruned. Failed or timed-out
 * enrichment means severity and confidence were never computed. In each
 * case the correct answer is "we do not know", which is not the same as
 * "passed" - see `fail-on-unrepresentative`.
 */
export const UNREPRESENTATIVE_KINDS = new Set([
  'wall_detected',
  // The CI endpoint refuses a sign-in wall outright (HTTP 422), so this
  // only reaches the action from a backend that scanned one anyway.
  'login_wall',
  'http_blocked',
  'bot_challenge',
  'consent_wall',
  'filter_chain_failed',
  'enrichment_timeout',
  'enrichment_failed',
]);

/**
 * The five third-party engines. `summary.engines_used` is the union of
 * every source that produced a finding, which also carries in-house
 * analyzers (wcag-checks, mobile-accessibility, focus-graph, ...), so its
 * length read "8 engines" beside a hosted report that says five. Mirrors
 * `ENGINES` in `src/lib/report/engineRoster.ts`; the action is
 * dependency-free, so the list is duplicated on purpose, and
 * backend/tests/platform/test_engine_roster_parity.py keeps the copies equal.
 */
export const ENGINES = ['axe-core', 'ibm-equal-access', 'arc-style', 'pa11y', 'lighthouse'];
const ENGINE_SET = new Set(ENGINES);

/** "5 of 5 engines + 3 in-house analyzers", the way the hosted report reads. */
export function rosterSummary(used) {
  const names = [...new Set((used || []).filter((n) => typeof n === 'string' && n))];
  if (names.length === 0) return 'no engines reported';
  const engines = names.filter((n) => ENGINE_SET.has(n)).length;
  const analyzers = names.length - engines;
  const head = `${engines} of ${ENGINES.length} engines`;
  return analyzers
    ? `${head} + ${analyzers} in-house analyzer${analyzers === 1 ? '' : 's'}`
    : head;
}

/** Hidden anchor that lets the action find and update its own comment. */
export const COMMENT_MARKER = '<!-- accessibility-pro-action -->';

const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi;

/**
 * A URL with its credential-bearing parts replaced: userinfo, query and
 * fragment. Origin and path are kept, so the reader still sees which page.
 *
 * F6 (2026-09-12). The README has auth-gated preview URLs passed through a
 * secret, and those carry `user:pass@` or a bypass token in the query. The
 * backend echoes the URL unchanged, and the PR comment, job summary, SARIF
 * and results file are not covered by the runner's log masking.
 */
export function redactUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!parsed.username && !parsed.password && !parsed.search && !parsed.hash) return url;
  const userinfo = parsed.username || parsed.password ? '***@' : '';
  const query = parsed.search ? '?***' : '';
  const fragment = parsed.hash ? '#***' : '';
  return `${parsed.protocol}//${userinfo}${parsed.host}${parsed.pathname}${query}${fragment}`;
}

/**
 * `value` with every URL on one of `hosts` redacted, and every URL that
 * carries userinfo redacted whatever its host, in every string at any
 * depth. Other URLs (rule help links) are left exactly as they were.
 */
export function redactUrlsIn(value, hosts) {
  if (typeof value === 'string') {
    return value.replace(URL_IN_TEXT, (match) => {
      let parsed;
      try {
        parsed = new URL(match);
      } catch {
        return match;
      }
      const ours = hosts.has(parsed.hostname) || parsed.username || parsed.password;
      return ours ? redactUrl(match) : match;
    });
  }
  if (Array.isArray(value)) return value.map((item) => redactUrlsIn(item, hosts));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactUrlsIn(item, hosts)])
    );
  }
  return value;
}

/** GitHub rejects issue comments above 65536 characters. */
const MAX_COMMENT_BYTES = 65_000;

/**
 * Normalise a warning entry.
 *
 * Most producers use `kind`; `ci_scanner`'s filter-chain warning uses
 * `type`. Accept both rather than silently dropping the one warning
 * that says the findings were never filtered.
 */
export function warningKind(warning) {
  return warning?.kind || warning?.type || '';
}

/** Warnings that should stop this scan from reading as a clean pass. */
export function unrepresentativeWarnings(warnings) {
  return (warnings || []).filter((w) => UNREPRESENTATIVE_KINDS.has(warningKind(w)));
}

/**
 * Escape text for inline markdown.
 *
 * Finding text is engine output, not authored copy: a selector like
 * `*|a` or a title containing a pipe would otherwise break out of a
 * table cell, and raw angle brackets read as HTML in a comment body.
 */
function md(value) {
  return String(value ?? '')
    .replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;'))
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
}

/** Wrap a selector or code fragment in a backtick span that cannot break. */
function code(value) {
  const text = String(value ?? '').replace(/\r?\n/g, ' ').trim();
  if (!text) return '';
  const fence = '`'.repeat(Math.max(1, longestBacktickRun(text) + 1));
  return `${fence}${text}${fence}`;
}

function longestBacktickRun(text) {
  let longest = 0;
  let current = 0;
  for (const char of text) {
    current = char === '`' ? current + 1 : 0;
    if (current > longest) longest = current;
  }
  return longest;
}

function truncate(value, limit) {
  const text = String(value ?? '').trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function severityCounts(result) {
  // Prefer the gate's own numbers: `violations` excludes the
  // framework-managed findings the backend skipped when it evaluated
  // the thresholds, while `summary.severity_counts` counts every
  // headline row. The comment used to show more violations than the
  // verdict it sat next to. Older backends only send the summary.
  const counts = result?.violations || result?.summary?.severity_counts || {};
  return {
    critical: Number(counts.critical || 0),
    high: Number(counts.high || 0),
    medium: Number(counts.medium || 0),
    low: Number(counts.low || 0),
  };
}

/** The public URL of a scan's report, or '' when there is nothing to link to. */
export function reportUrlFor(stats, reportDomain) {
  if (!stats?.id || !stats?.shareToken) return '';
  return `${reportDomain}/report/${stats.id}?s=${encodeURIComponent(stats.shareToken)}`;
}

/**
 * Say where each gate-skipped finding's acknowledgement came from.
 *
 * Since 2026-09-20 the backend also applies the dismissals an account
 * saved for the scanned site (`POST /api/account/dismissals`, on runs
 * that carry `accessibility-pro-token`), and stamps them exactly
 * like `ignore-rules` matches (`gate_ignored` = the matching entry).
 * The workflow's own entries are tried first, so a stamp equal to one of
 * them is the workflow's; any other stamp is a saved dismissal. Without
 * this, a workflow with no `ignore-rules` at all was told its findings
 * "matched ignore-rules".
 *
 * Mutates `result`: tags each stamped issue with `gate_ignored_source`
 * and records the split of the backend's `gate_ignored` total.
 */
export function labelIgnoredSources(result, ignoreRules = []) {
  if (!result) return result;
  const own = new Set((ignoreRules || []).map((entry) => String(entry).trim()));
  let savedSeen = 0;
  for (const issue of result.issues || []) {
    if (!issue?.gate_ignored) continue;
    const mine = own.has(String(issue.gate_ignored).trim());
    issue.gate_ignored_source = mine ? 'ignore-rules' : 'saved';
    if (!mine) savedSeen += 1;
  }
  // The total is the backend's; the issue list can be truncated, so the
  // split is only inferred where it has to be. No workflow entries means
  // every acknowledgement was a saved dismissal, and no saved dismissals
  // applied means every one was the workflow's.
  const total = Number(result.gate_ignored || 0);
  let saved;
  if (own.size === 0) saved = total;
  else if (!Number(result.dismissals_applied || 0)) saved = 0;
  else saved = Math.min(total, savedSeen);
  result.gate_ignored_sources = { ignore_rules: total - saved, saved };
  return result;
}

/** Aggregate every field the outputs and the gate need from one scan. */
export function summarise(result) {
  const counts = severityCounts(result);
  const issues = result?.issues || [];
  const warnings = result?.warnings || [];
  return {
    id: result?.id || '',
    // Reports became private to their owner on 2026-09-08. A PR comment
    // is read by someone signed out of Accessibility Pro, so the link
    // has to carry the share token the backend minted when it persisted
    // this scan. Absent when the row failed to persist - `reportUrlFor`
    // then yields '' and the link is omitted rather than 404ing.
    shareToken: result?.share_token || '',
    url: result?.url || '',
    score: Math.round(Number(result?.score ?? 0)),
    passed: result?.passed !== false,
    // The verdict is the backend's to give. A response without one is
    // not a pass; `main.mjs` refuses it rather than defaulting, because
    // the alternative is a second gate implementation that can drift
    // from the first - which is the bug v2 exists to fix.
    hasBackendVerdict: typeof result?.passed === 'boolean',
    counts,
    totalIssues: issues.length,
    manualReviewCount: Number(
      result?.summary?.manual_review_count ?? (result?.manual_review || []).length
    ),
    engines: result?.summary?.engines_used || result?.engines_run || [],
    warnings,
    blockingWarnings: unrepresentativeWarnings(warnings),
    gateExcluded: Number(result?.gate_excluded_framework_managed || 0),
    // Split by source when `labelIgnoredSources` ran; a result it never
    // saw keeps the pre-2.4.2 reading, all of it `ignore-rules`.
    gateIgnored: Number(
      result?.gate_ignored_sources?.ignore_rules ?? result?.gate_ignored ?? 0
    ),
    gateDismissed: Number(result?.gate_ignored_sources?.saved ?? 0),
    dismissalsApplied: Number(result?.dismissals_applied || 0),
    ignoreUnmatched: Array.isArray(result?.ignore_rules_unmatched)
      ? result.ignore_rules_unmatched.map(String)
      : [],
    truncation: result?.truncation || null,
    failReason: typeof result?.summary_text === 'string' ? result.summary_text : '',
    durationMs: Number(result?.scan_duration_ms || 0),
    quota: result?.quota || null,
  };
}

/**
 * One line of plan usage, when the caller authenticated.
 *
 * Anonymous scans get nothing here: the backend has no account to
 * report against, and inventing a number would be worse than silence.
 * Warned at 90% so a team sees it on a PR comment rather than on the
 * build that finally 402s.
 */
export function quotaLine(quota) {
  if (!quota || !quota.tier) return '';
  if (quota.unlimited) return `Plan: ${quota.tier} (unlimited CI scans)`;
  const used = Number(quota.ci_scans_used ?? 0);
  const limit = Number(quota.ci_scans_limit ?? 0);
  if (!limit) return `Plan: ${quota.tier}`;
  const pct = used / limit;
  const warn = pct >= 0.9 ? ' ⚠️' : '';
  return `Plan: ${quota.tier} · ${used} of ${limit} CI scans used this month${warn}`;
}

/** One line describing the element a finding is about. */
function elementLine(issue) {
  const name = issue.accessible_name
    ? ` "${md(truncate(issue.accessible_name, 60))}"`
    : '';
  const tag = issue.element_tag ? `${md(issue.element_tag)}${name}` : '';
  let selector = issue.location || (issue.occurrence_selectors || [])[0] || '';
  // The backend appends a `/* "first few words" */` comment to selectors
  // so a bare `select` or `html` is identifiable on its own. Once the
  // tag and accessible name are already on this line, that comment just
  // prints the same text a second time.
  if (tag && name) selector = selector.replace(/\s*\/\*.*?\*\/\s*$/, '').trim();
  if (tag && selector) return `${tag} at ${code(truncate(selector, 120))}`;
  if (tag) return tag;
  if (selector) return code(truncate(selector, 120));
  return '';
}

/** Contrast findings carry numbers; showing them makes the claim checkable. */
function contrastLine(issue) {
  if (typeof issue.contrast_ratio !== 'number') return '';
  const span =
    typeof issue.contrast_ratio_min === 'number' &&
    typeof issue.contrast_ratio_max === 'number' &&
    issue.contrast_ratio_min !== issue.contrast_ratio_max
      ? `${issue.contrast_ratio_min.toFixed(2)} to ${issue.contrast_ratio_max.toFixed(2)}:1`
      : `${issue.contrast_ratio.toFixed(2)}:1`;
  const required =
    typeof issue.contrast_required === 'number'
      ? `, required ${issue.contrast_required}:1`
      : '';
  return `measured ${span}${required}`;
}

/** The chips after a finding title: what it is and how well we know it. */
function issueChips(issue) {
  const chips = [];
  if (issue.severity) chips.push(md(issue.severity));
  if (issue.wcag) chips.push(`WCAG ${md(issue.wcag)}`);
  const evidence = EVIDENCE_LABELS[issue.evidence_level];
  if (evidence) chips.push(evidence);
  if (issue.confidence_bucket) chips.push(`${md(issue.confidence_bucket)} confidence`);
  if (issue.legal_risk_tier === 1) chips.push('**Tier-1 legal risk**');
  const occurrences = Number(issue.occurrences || 0);
  if (occurrences > 1) chips.push(`${occurrences} elements`);
  if (typeof issue.fixability_minutes === 'number' && issue.fixability_minutes > 0) {
    chips.push(`~${issue.fixability_minutes} min to fix`);
  }
  if (issue.framework_managed) {
    chips.push(
      `does not gate the build (${md(issue.framework_name || issue.framework_managed)})`
    );
  }
  if (issue.gate_ignored) {
    chips.push(
      issue.gate_ignored_source === 'saved'
        ? `saved dismissal: ${md(issue.gate_ignored)}`
        : `ignored via ignore-rules: ${md(issue.gate_ignored)}`
    );
  }
  return chips.join(' · ');
}

/**
 * Render one finding.
 *
 * `llm_rationale` is labelled by provenance. A customer once read
 * verbatim Lighthouse audit text as an AI analysis of their page, so
 * text generated by Claude and text restating rule metadata must never
 * look alike.
 */
function renderIssue(issue, index) {
  const lines = [`${index}. **${md(issue.title || 'Untitled finding')}**`];
  const chips = issueChips(issue);
  if (chips) lines.push(`   ${chips}`);
  const element = elementLine(issue);
  const contrast = contrastLine(issue);
  const detail = [element, contrast].filter(Boolean).join(' · ');
  if (detail) lines.push(`   ${detail}`);
  if (issue.llm_rationale) {
    const source =
      issue.llm_rationale_source === 'claude' ? 'AI analysis' : 'rule template';
    lines.push(`   _${source}:_ ${md(truncate(issue.llm_rationale, 320))}`);
  } else if (issue.description) {
    // No rationale means AI enrichment was unavailable for this scan.
    // The engine's own description is the honest fallback, labelled as
    // such so nobody reads verbatim rule metadata as an analysis of
    // their page.
    lines.push(`   _${md(issue.source_engine || 'engine')}:_ ${md(truncate(issue.description, 320))}`);
  }
  return lines.join('\n');
}

function renderWarnings(warnings) {
  if (!warnings.length) return [];
  return warnings.flatMap((warning) => {
    const severity = String(warning.severity || 'warning').toLowerCase();
    const icon = severity === 'error' ? '\u{1F6D1}' : severity === 'info' ? 'ℹ️' : '⚠️';
    const title = WARNING_TITLES[warningKind(warning)] || 'Scan notice';
    return [`> ${icon} **${title}**`, `> ${md(truncate(warning.message, 600))}`, ''];
  });
}

function renderCountsTable(stats) {
  return [
    '| Critical | High | Medium | Low | Needs review |',
    '|---:|---:|---:|---:|---:|',
    `| ${stats.counts.critical} | ${stats.counts.high} | ${stats.counts.medium} ` +
      `| ${stats.counts.low} | ${stats.manualReviewCount} |`,
    '',
  ];
}

/**
 * Render one scanned URL.
 *
 * `topIssues` is the cap on findings listed inline. The full set is
 * always one click away in the hosted report, and a comment with 200
 * rows of one rule is a comment nobody reads.
 */
export function renderScanSection(
  result,
  { reportDomain, topIssues = 5, heading = '###', showVerdict = true }
) {
  const stats = summarise(result);
  const reportUrl = reportUrlFor(stats, reportDomain);
  const verdict = stats.passed ? '✅ Passed · ' : '❌ Failed · ';
  const engines = rosterSummary(stats.engines);

  const lines = [
    `${heading} ${showVerdict ? verdict : ''}${md(stats.url)}`,
    '',
    `Score **${stats.score}/100** · WCAG ${md(result?.wcag_level || 'AA')} · ` +
      `${stats.totalIssues} finding${stats.totalIssues === 1 ? '' : 's'} · ${engines}` +
      (stats.durationMs ? ` · ${(stats.durationMs / 1000).toFixed(0)}s` : ''),
    '',
  ];

  if (!stats.passed && stats.failReason) {
    lines.push(`> **Gate:** ${md(stats.failReason.replace(/^FAILED:\s*/, ''))}`, '');
  }

  lines.push(...renderWarnings(stats.warnings));
  lines.push(...renderCountsTable(stats));

  const issues = [...(result?.issues || [])]
    .sort((a, b) => (b.impact_score ?? 0) - (a.impact_score ?? 0))
    .slice(0, topIssues);

  if (issues.length === 0) {
    lines.push(
      stats.totalIssues === 0
        ? `No automatable WCAG ${md(result?.wcag_level || 'AA')} violations detected.`
        : 'No findings to list.',
      ''
    );
  } else {
    lines.push(`**Top ${issues.length} by impact**`, '');
    lines.push(...issues.map((issue, i) => renderIssue(issue, i + 1)));
    lines.push('');
    if (stats.totalIssues > issues.length) {
      lines.push(
        `${stats.totalIssues - issues.length} further finding` +
          `${stats.totalIssues - issues.length === 1 ? '' : 's'} in the full report.`,
        ''
      );
    }
  }

  // Disclosures. Each one exists because hiding it would let a number
  // above be read as more complete than it is.
  const notes = [];
  if (stats.manualReviewCount > 0) {
    notes.push(
      `${stats.manualReviewCount} finding${stats.manualReviewCount === 1 ? '' : 's'} ` +
        `could not be automatically verified and ` +
        `${stats.manualReviewCount === 1 ? 'is' : 'are'} listed under ` +
        (reportUrl ? `[needs review](${reportUrl}#needs-review)` : 'needs review') +
        ' rather than counted as violations.'
    );
  }
  if (stats.gateExcluded > 0) {
    const one = stats.gateExcluded === 1;
    notes.push(
      `${stats.gateExcluded} finding${one ? '' : 's'} in framework-managed markup ` +
        '(component-library portals, consent widgets, streaming-SSR artifacts) ' +
        `${one ? 'is' : 'are'} shown in the report but ${one ? 'does' : 'do'} not ` +
        'gate the build, because they cannot be fixed in your application code.'
    );
  }
  if (stats.gateIgnored > 0) {
    const one = stats.gateIgnored === 1;
    notes.push(
      `${stats.gateIgnored} finding${one ? '' : 's'} matched ignore-rules and ` +
        `${one ? 'does' : 'do'} not gate the build. ${one ? 'It' : 'They'} still ` +
        `count${one ? 's' : ''} in the report and the score.`
    );
  }
  if (stats.gateDismissed > 0) {
    const one = stats.gateDismissed === 1;
    notes.push(
      `${stats.gateDismissed} finding${one ? '' : 's'} matched a dismissal saved on your ` +
        `Accessibility Pro account and ${one ? 'does' : 'do'} not gate the build. ` +
        `${one ? 'It' : 'They'} still ` +
        `count${one ? 's' : ''} in the report and the score.`
    );
  }
  if (stats.ignoreUnmatched.length > 0) {
    notes.push(
      `ignore-rules entr${stats.ignoreUnmatched.length === 1 ? 'y' : 'ies'} that ` +
        `matched no finding: ${stats.ignoreUnmatched.map(md).join(', ')}. ` +
        'The verdict did not depend on it.'
    );
  }
  if (stats.truncation && stats.truncation.hidden_count) {
    notes.push(
      `${stats.truncation.hidden_count} repeat occurrence` +
        `${stats.truncation.hidden_count === 1 ? '' : 's'} of already-listed rules ` +
        'were trimmed from this page. A representative sample of each rule is kept.'
    );
  }
  if (notes.length) {
    // One blockquote, one bullet per note. Consecutive `> ` lines are a
    // single paragraph in GitHub-flavoured markdown, so separate notes
    // written that way run together into an unreadable wall.
    lines.push('> **Worth knowing**', ...notes.map((note) => `> - ${note}`), '');
  }

  if (reportUrl) {
    // No violations means nothing to patch; offering "Copy-as-PR fixes"
    // on a clean scan sends the reader to an empty tab. And an
    // unattributed scan (no accessibility-pro-token) belongs to no
    // account, so nobody can ever generate fixes for it: `quota` is only
    // present when the backend saw a verified token.
    const fixes =
      stats.totalIssues > 0 && stats.quota
        ? ` · [Copy-as-PR fixes](${reportUrl}#ai-fixes)`
        : stats.totalIssues > 0
          ? ' · Copy-as-PR fixes need an `accessibility-pro-token` so the scan is attributed to your account'
          : '';
    lines.push(`**[Open the full report](${reportUrl})**${fixes}`, '');
  }

  const plan = quotaLine(stats.quota);
  if (plan) lines.push(`<sub>${md(plan)}</sub>`, '');

  return lines.join('\n');
}

/** The complete PR comment body, including the sticky-update marker. */
export function renderComment(results, { reportDomain, topIssues, failed, context }) {
  const multiple = results.length > 1;
  const anyBlocking = results.some((r) => summarise(r).blockingWarnings.length > 0);
  // "Not representative" outranks "gate failed": if the scanner never
  // saw the real page, the findings the gate ran over are themselves in
  // doubt, and telling the reviewer to go fix them would be wrong.
  const headline = anyBlocking
    ? '⚠️ Accessibility Pro: result not representative'
    : failed
      ? '❌ Accessibility Pro: build gate failed'
      : '✅ Accessibility Pro: build gate passed';

  const parts = [
    COMMENT_MARKER,
    `## ${headline}`,
    '',
    ...(multiple
      ? [
          `${results.length} URLs scanned` +
            (context.sha ? ` at ${context.sha.slice(0, 7)}` : ''),
          '',
        ]
      : []),
    ...results.map((result) =>
      // The comment's own heading already carries the verdict; repeating
      // it on a single URL's section reads as two different statements.
      renderScanSection(result, {
        reportDomain,
        topIssues,
        heading: '###',
        showVerdict: multiple,
      })
    ),
    '---',
    '<sub>Findings are ranked by measured impact, not engine order. On scans ' +
      'attributed to an account, every Copy-as-PR diff is applied to the ' +
      'captured DOM and re-scanned before it is offered; when no safe patch ' +
      'exists you get a snippet marked for manual review instead of an ' +
      'unverified diff.</sub>',
  ];

  const body = parts.join('\n');
  if (body.length <= MAX_COMMENT_BYTES) return body;
  return (
    body.slice(0, MAX_COMMENT_BYTES - 200) +
    '\n\n> Comment truncated at GitHub’s size limit. Open the full report above.'
  );
}

/** The job-summary body shown on the workflow run page. */
export function renderSummary(results, { reportDomain, topIssues }) {
  return [
    '## Accessibility Pro scan',
    '',
    ...results.map((result) =>
      renderScanSection(result, { reportDomain, topIssues, heading: '###' })
    ),
  ].join('\n');
}
