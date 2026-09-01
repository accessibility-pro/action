/**
 * SARIF 2.1.0 emitter.
 *
 * Ports `toSarif` and `bucketKeyFor` from `src/lib/report/exporters.ts`
 * and `src/lib/report/bucket_key.ts` so a workflow can hand findings to
 * GitHub code scanning without a human downloading the file from the
 * report UI first. Keep the three in sync: a fingerprint that diverges
 * from the backend's baseline key makes every scan look net-new, which
 * destroys the longitudinal "fixed / introduced" status that code
 * scanning exists to provide.
 */

const SEVERITY_TO_LEVEL = {
  critical: 'error',
  serious: 'error',
  high: 'error',
  moderate: 'warning',
  medium: 'warning',
  low: 'note',
  minor: 'note',
};

/**
 * Cross-run identity for a finding.
 *
 * Matches backend/services/pipeline/baseline_diff.py `_key()`. Never
 * use `issue.id`: arc-style emits a per-scan counter there, so keying
 * on it would make every run report every finding as brand new.
 */
export function bucketKeyFor(issue) {
  if (issue.dedup_key) return String(issue.dedup_key);
  if (issue.issue_fingerprint) return String(issue.issue_fingerprint);
  if (issue.fingerprint) return String(issue.fingerprint);
  const ruleClass =
    issue.canonical_rule_class || issue.rule_id || issue.id || 'unknown';
  const wcag = Array.isArray(issue.wcag) ? issue.wcag.join(',') : issue.wcag || '';
  return `${ruleClass}:${wcag}`;
}

function levelFor(severity) {
  return SEVERITY_TO_LEVEL[String(severity || '').toLowerCase()] ?? 'note';
}

/**
 * Build a SARIF log covering every scanned URL.
 *
 * One run per URL, each with its own `automationDetails.id`, so a
 * matrix of pages uploaded under one category does not have each page
 * overwrite the last.
 */
export function toSarif(results, { version = '2.0.0' } = {}) {
  return {
    version: '2.1.0',
    $schema:
      'https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-schema-2.1.0.json',
    runs: results.map((scan) => runForScan(scan, version)),
  };
}

function runForScan(scan, version) {
  const rulesById = new Map();
  const results = [];

  for (const issue of scan.issues || []) {
    const ruleId = issue.rule_id || issue.id || issue.title || 'unknown';
    if (!rulesById.has(ruleId)) {
      rulesById.set(ruleId, {
        id: ruleId,
        name: issue.title || ruleId,
        shortDescription: { text: String(issue.title || ruleId).slice(0, 120) },
        fullDescription: { text: String(issue.description || '').slice(0, 500) },
        ...(issue.help_url ? { helpUri: issue.help_url } : {}),
        properties: {
          wcag: issue.wcag || '',
          engine: issue.source_engine || '',
          ...(issue.wcag ? { tags: ['accessibility', `wcag-${issue.wcag}`] } : {}),
        },
      });
    }

    const selector = issue.location || (issue.occurrence_selectors || [])[0] || '';
    results.push({
      ruleId,
      level: levelFor(issue.severity),
      message: {
        text: String(issue.description || issue.title || '').slice(0, 500),
      },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: issue.source_url || scan.url || '' },
            // Code scanning requires a region on every physical
            // location. There is no source file behind a URL scan, so
            // line 1 stands in for "this page".
            region: { startLine: 1 },
          },
          ...(selector
            ? { logicalLocations: [{ name: selector, kind: 'element' }] }
            : {}),
        },
      ],
      partialFingerprints: { fingerprint: bucketKeyFor(issue) },
      properties: {
        wcag: issue.wcag || '',
        severity: issue.severity || '',
        impact_score: issue.impact_score,
        evidence_level: issue.evidence_level || '',
        confidence_bucket: issue.confidence_bucket || '',
        occurrences: issue.occurrences ?? 1,
        framework_managed: issue.framework_managed || '',
      },
    });
  }

  return {
    tool: {
      driver: {
        name: 'Accessibility Pro',
        version,
        informationUri: 'https://www.accessibilitypro.app/',
        rules: [...rulesById.values()],
      },
    },
    automationDetails: { id: `accessibility-pro/${scan.url || scan.id || 'scan'}` },
    results,
    properties: {
      scan_id: scan.id,
      scan_url: scan.url,
      score: scan.score,
      wcag_level: scan.wcag_level,
      engines: scan.summary?.engines_used || scan.engines_run || [],
    },
  };
}
