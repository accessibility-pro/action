# Changelog · Accessibility Pro Action

All notable changes to the GitHub Action ship here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [SemVer](https://semver.org).

## [Unreleased]

## [2.1.2] · 2026-09-05

### Fixed
- **The action announced the wrong version of itself.** `2.1.1` printed
  `v2.1.0` on every run and, more consequentially, stamped `2.1.0` as
  the SARIF tool version, so GitHub code scanning filed findings under a
  release that never contained the code that produced them. The constant
  is hand-kept; nothing compared it to the changelog. Now something
  does: the end-to-end suite fails when the declared version, the run
  banner and the SARIF tool version disagree with the newest changelog
  entry.

## [2.1.1] · 2026-09-05

A correctness pass over what the run reports. No input or output
changes, and the build verdict is untouched: the scanner still owns it.

### Fixed
- **Annotations followed a hard-coded critical/high list**, so a run
  configured with `fail-on: wcag` failed the build with an empty
  annotations panel: Level A findings that gate are frequently medium.
  The annotated set is now whatever this run's gate can fail, read from
  the gate itself, and framework-managed findings are never annotated
  because they cannot fail the build they would sit beside.
- **The comment's counts could exceed the verdict beside them.** They
  came from `summary.severity_counts`, which counts every headline row,
  while the gate is evaluated on `violations`, which excludes the
  framework-managed findings the backend deliberately skips. The comment
  now prefers the gate's own numbers and falls back to the summary for
  older backends.
- **Copy-as-PR was offered to runs that can never use it.** Fixes are
  generated for scans attributed to an account; an anonymous scan has no
  account that could open the tab. The link now appears only on an
  attributed scan, and an anonymous one is told what to add instead of
  being sent to a tab that will not serve it.
- **The free-tier permissions note overstated the risk.** Without
  `id-token: write`, quota is bucketed on the repository name the
  workflow reports, which nothing verifies; it is not shared across
  every repository behind a runner IP. Adding the permission makes the
  bucket provable rather than merely private.

### Documentation
- `plan-tier` and `ci-scans-remaining`, added in 2.1.0, are in the
  outputs table.
- The `accessibility-pro-token` description says what a token actually
  buys: attribution, which is what lets you open the report signed in
  and generate Copy-as-PR fixes.

## [2.1.0] · 2026-09-02

### Added
- A token now buys something concrete. Authenticated scans are
  attributed to your account, appear in your dashboard next to your
  interactive scans, and draw on your plan's **CI allowance** - a
  budget separate from your monthly interactive scans (Solo 1,000,
  Team 5,000, Business 20,000 per month).
- The remaining allowance is printed on every run and shown in the PR
  comment, with a warning at 90%, so a team sees it coming rather than
  meeting it on the build that fails.
- New outputs: `plan-tier` and `ci-scans-remaining`. Both are empty for
  anonymous runs rather than zero, because there is no account to
  report against and a zero would read as "nothing left".
- An exhausted allowance answers HTTP 402 with the plan, the counts and
  the reset, kept distinct from the free tier's 429 rate limit.

### Fixed
- The README claimed a token made scans "count against your plan quota"
  and generated Copy-as-PR fixes. Neither was true: the endpoint read no
  identity at all, and Copy-as-PR is a separate authenticated route in
  the hosted report. Both statements are now accurate.

## [2.0.0] · 2026-09-01

A rebuild that closes four months of drift between the action and the
scanner it drives. Upgrading from `@v1` to `@v2` needs no input changes
for most repositories; see "Changed" for the three behaviours that move
on purpose.

### Fixed

- **The action and the hosted report could disagree about the same
  scan.** v1 recomputed its own verdict from `severity_counts` while the
  backend computed one in `evaluate_ci_gate`, which excludes
  framework-managed findings (component-library portals, consent
  widgets, reCAPTCHA and Turnstile frames, streaming-SSR artifacts) and
  rules that are not success criteria. A build could fail on findings
  the report called a pass, and no amount of reading the report
  explained why. The action now sends thresholds and the scanner returns
  the verdict, so there is one gate.
- **Scans longer than five minutes failed as accessibility failures.**
  v1 used `fetch`, whose undici `headersTimeout` defaults to 300s and
  cannot be raised without a dependency. A five-engine scan of a heavy
  SPA legitimately exceeds that; the throw was unreported and Node
  exited 1, which reads as "the gate failed". The client is now built on
  `node:https`, which imposes no header deadline, with an explicit
  `timeout-minutes` budget (default 15) and a retry for transient
  gateway and network failures. Infrastructure failures are now labelled
  as such instead of looking like findings.
- **The "needs review" disclosure never appeared.** v1 re-fetched the
  scan from `GET /api/scans/{id}` and read `scan.manual_review`, which
  that endpoint does not expose at the top level; the count was
  therefore always zero. The comment is now rendered from the scan
  response itself, so nothing the scanner reports can be lost in
  transit. This also removes a race in which the comment was silently
  skipped when persistence had not completed.
- **Scan warnings never reached anyone.** A bot-detection challenge, a
  consent wall, an HTTP block, a skipped false-positive filter chain, or
  a timed-out confidence pass were all invisible in CI. A Cloudflare
  interstitial could score cleanly and pass a build. Warnings are now
  shown in the comment and the job summary, and by default they fail the
  build.
- Em dashes are scrubbed from finding text. The hosted report scrubs at
  its read boundary; the CI scan response does not pass through it, so
  PR comments were the one surface still showing raw engine text.
- Finding text is escaped for markdown. A selector or title containing
  a pipe or an angle bracket used to break out of its table cell.
- Warnings shaped with `type` rather than `kind` are recognised. The
  filter-chain warning uses the former, so the one warning that says
  "these findings were never filtered" was the one being dropped.

### Added

- **Sticky comments.** One comment per pull request, updated in place on
  every push. `comment: new` restores one comment per run; `comment:
  off` disables it.
- **`fail-on: wcag`.** Fails on any Level A or AA success-criterion
  failure regardless of severity, which is what a compliance deadline
  actually calls for.
- **`thresholds`.** Per-severity allowances as JSON, for paying down a
  backlog without a red build every day.
- **`fail-on-unrepresentative`** (default `true`). A scan that never saw
  the real page is reported as a failure, not a pass.
- **SARIF output** via `sarif-file`, ready for
  `github/codeql-action/upload-sarif`. Fingerprints match the backend's
  baseline keys, so code scanning tracks findings across runs instead of
  reporting every scan as new.
- **`results-file`** writes the raw scan payload for your own tooling.
- **Multiple URLs.** `url` accepts one per line. Counts are summed;
  `score`, `scan-id` and `report-url` describe the worst page. A page
  that cannot be scanned is named in the failure and never counted as a
  pass, but the pages that did scan are still reported rather than
  discarded along with the quota they cost.
- **GitHub OIDC.** The action mints a signed token so free-tier quota is
  attributed to your repository rather than to a runner IP shared with
  every other repository behind the same NAT address. Needs
  `permissions: id-token: write`; the legacy header remains as a
  fallback.
- **`engines`** to run a subset of the five engines.
- **Workflow annotations** for build-failing findings, and `annotations`
  to turn them off.
- Richer findings in the comment: evidence level, confidence, Tier-1
  legal-risk marker, occurrence count, estimated fix time, the element's
  tag and accessible name, and measured contrast against the required
  ratio. AI-written rationale is labelled separately from an engine's
  own description.
- Disclosure lines for gate-excluded framework-managed findings and for
  repeat occurrences trimmed by the per-page cap.
- New outputs: `passed`, `violations-medium`, `violations-low`,
  `total-issues`, `manual-review-count`, `warnings-count`,
  `engines-used`, `sarif-file`, `results-file`.
- New inputs: `github-token`, `timeout-minutes`, `retries`,
  `top-issues`, `oidc-audience`.
- Input validation with actionable messages. A typo in `wcag-level` or
  `thresholds` now fails immediately instead of being sent to the
  backend.
- GitHub Enterprise Server support: the GitHub API base is read from
  `GITHUB_API_URL` rather than hard-coded.
- An end-to-end test suite (`node test/e2e.mjs`) and a CI workflow. The
  suite runs the action against a mock backend and mock GitHub API and
  asserts on exit codes, outputs, job-summary markdown and the posted
  comment body.

### Changed

- **The action is now a JavaScript action (`node24`) rather than a
  composite action.** v1 ran `actions/setup-node@v4` inside your job,
  which changed the Node version every later step in that job saw. It no
  longer touches your toolchain, and it starts faster.
- **Comments are sticky by default** (was: a new comment per run).
- **An unrepresentative scan fails by default** (was: reported as a
  pass).
- Builds that failed only on framework-managed findings now pass, which
  is what the report always said.
- Rate-limit, rejected-token, blocked-URL and backend-timeout responses
  produce a specific message naming the remedy, rather than a status
  code.
- A failure to post the comment never fails the build.

### Deprecated

- `comment-on-pr`. Use `comment: off`. The old spelling still works and
  logs a notice.

## [1.0.1] · 2026-05-12

### Changed
- README, CHANGELOG, and supporting documentation rewritten in UK
  English with no em-dashes or en-dashes in user-facing copy.
- Marketplace branding colour updated from `purple` to `green` to
  match the signal-green brand mark on accessibilitypro.app.

## [1.0.0] · 2026-05-05

First public Marketplace release.

### Added
- `action.yml` composite action with 7 inputs and 5 outputs.
- `scripts/scan.mjs`: POSTs `/api/ci/scan` and exports scan metadata
  as action outputs (`scan-id`, `score`, `violations-critical`,
  `violations-high`, `report-url`).
- `scripts/comment.mjs`: posts an impact-ranked top-5 PR comment
  with deep links to Copy-as-PR fixes.
- `fail-on` enforcement (`error` / `warning` / `none`).
- GitHub step-summary markdown rendering with severity table and
  report deep link.
- Free-tier rate limits on the anonymous CI scan path. Tokens bypass
  via plan quota.
- Optional `accessibility-pro-token` input that unlocks Team or
  Business quota and surfaces validated Copy-as-PR diffs in PR
  comments.
- Configurable backend and report-domain inputs for self-hosted
  deployments.
- Sandbox-validated patch generation: every Copy-as-PR diff is
  applied to the captured DOM and re-scanned before emit; failed
  patches fall back to a "Needs manual review" snippet rather than
  emitting an unverified diff.
