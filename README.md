# Accessibility Pro Scan

WCAG 2.2 accessibility gate for pull requests. Five engines, live-DOM
verification, one comment that updates itself, and fixes you can apply.

[![CI](https://github.com/accessibility-pro/action/actions/workflows/ci.yml/badge.svg)](https://github.com/accessibility-pro/action/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![accessibilitypro.app](https://img.shields.io/badge/accessibilitypro.app-green)](https://www.accessibilitypro.app)

## Quick start

```yaml
# .github/workflows/accessibility.yml
name: Accessibility
on: pull_request

permissions:
  pull-requests: write   # post the results comment
  id-token: write        # count free-tier quota against this repo

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: accessibility-pro/action@v2
        with:
          url: ${{ secrets.STAGING_URL }}
```

That is the whole setup. No checkout, no `setup-node`, no browser
install: the scan runs on our infrastructure and the action is a
dependency-free Node script that talks to it.

## What you get

One comment per pull request, updated in place on every push rather
than stacked fifteen deep by the time anyone reviews it:

> ## ❌ Accessibility Pro: build gate failed
>
> ### https://staging.acme.example
>
> Score **41/100** · WCAG AA · 3 findings · 5 engines · 41s
>
> | Critical | High | Medium | Low | Needs review |
> |---:|---:|---:|---:|---:|
> | 1 | 2 | 0 | 0 | 3 |
>
> **Top 3 by impact**
>
> 1. **Text has insufficient contrast**
>    critical · WCAG 1.4.3 · pixel-verified · high confidence · **Tier-1 legal risk** · 9 elements · ~5 min to fix
>    button "Sign up" at `.btn.primary` · measured 2.79:1, required 4.5:1

Findings are ordered by measured impact, not by the order an engine
happened to emit them. Each one carries how it was verified, so you can
tell a pixel-sampled contrast failure from a single engine's guess
before you spend an afternoon on it.

The same content lands in the job summary, so runs on `push`, `schedule`
and `workflow_dispatch` are just as readable as pull requests.

## Recipes

### Gate on conformance, not on severity

`fail-on: wcag` fails the build for any Level A or AA success-criterion
failure, whatever severity it carries. This is the setting for teams
working to a compliance deadline.

```yaml
      - uses: accessibility-pro/action@v2
        with:
          url: https://staging.acme.example
          wcag-level: AA
          fail-on: wcag
```

### Scan several pages in one step

```yaml
      - uses: accessibility-pro/action@v2
        with:
          url: |
            https://staging.acme.example/
            https://staging.acme.example/pricing
            https://staging.acme.example/checkout
```

Counts are summed across pages, and `score` / `scan-id` / `report-url`
describe the worst page, which is the one you want to open first. Each
page is a separate scan against your quota.

### Track findings in the Security tab

```yaml
      - uses: accessibility-pro/action@v2
        id: a11y
        with:
          url: https://staging.acme.example
          sarif-file: a11y.sarif
          fail-on: none          # let code scanning own the verdict

      - uses: github/codeql-action/upload-sarif@v3
        if: always()
        with:
          sarif_file: a11y.sarif
          category: accessibility
```

Fingerprints match the backend's own baseline keys, so code scanning
tracks a finding across runs as fixed or reintroduced instead of
reporting every scan as brand new. Results appear in the Security tab;
they are not annotated onto source lines, because a URL scan has no
source file to annotate.

### Pay down a backlog without a red build every day

```yaml
        with:
          url: https://staging.acme.example
          thresholds: '{"critical": 0, "high": 5}'
```

No new criticals, and no more than five high-severity findings.
Severities you leave out are unlimited.

### Use the results in later steps

```yaml
      - uses: accessibility-pro/action@v2
        id: a11y
        with:
          url: https://staging.acme.example
          fail-on: none

      - name: Block release below 90
        if: steps.a11y.outputs.score < 90
        run: |
          echo "Score ${{ steps.a11y.outputs.score }}, report ${{ steps.a11y.outputs.report-url }}"
          exit 1
```

### Watch production overnight

```yaml
on:
  schedule:
    - cron: '0 6 * * *'

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: accessibility-pro/action@v2
        with:
          url: https://www.acme.example
          fail-on: wcag
```

A scheduled run has no pull request to comment on, so the results go to
the job summary and the workflow's own failure notification.

## Inputs

| Input | Default | Description |
|---|---|---|
| `url` | *(required)* | URL to scan. One per line to scan several. Use a repo secret for auth-gated previews. |
| `wcag-level` | `AA` | `A`, `AA`, or `AAA`. |
| `fail-on` | `error` | `error` (critical or high fails), `warning` (adds medium), `wcag` (any Level A/AA criterion failure), `none` (report only). |
| `thresholds` | `''` | JSON object of per-severity allowances that overrides `fail-on`, e.g. `{"critical": 0, "high": 3}`. |
| `fail-on-unrepresentative` | `true` | Fail when the scanner could not see the real page. See below. |
| `engines` | *(all five)* | Comma-separated subset of `axe-core`, `lighthouse`, `pa11y`, `ibm-equal-access`, `arc-style`. |
| `comment` | `sticky` | `sticky` updates one comment in place, `new` adds one per run, `off` disables it. |
| `top-issues` | `5` | Findings listed inline, ranked by impact (1 to 25). |
| `annotations` | `true` | Emit build-failing findings as workflow annotations. |
| `sarif-file` | `''` | Path to write a SARIF 2.1.0 report to. |
| `results-file` | `''` | Path to write the raw scan payload (JSON) to. |
| `accessibility-pro-token` | `''` | API token. Scans are attributed to your account, appear in your dashboard, and draw on your plan's CI allowance instead of the free tier. |
| `github-token` | `${{ github.token }}` | Token used to post the comment. |
| `timeout-minutes` | `15` | Per-attempt budget for one scan request (1 to 60). |
| `retries` | `1` | Retries for transient backend or network failures (0 to 3). |
| `backend-url` | Production | Override for self-hosted deployments. |
| `report-domain` | Production | Override for a self-hosted frontend. |
| `oidc-audience` | `https://api.accessibilitypro.app` | Audience for the OIDC token. Change only when self-hosting. |

`comment-on-pr` from v1 is still accepted: `comment-on-pr: false`
behaves as `comment: off` and logs a deprecation notice.

## Outputs

| Output | Description |
|---|---|
| `passed` | `true` when every scanned URL cleared the gate. |
| `score` | Score (0 to 100) of the lowest-scoring URL. |
| `scan-id` | Scan id of the lowest-scoring URL. |
| `report-url` | Hosted report for the lowest-scoring URL. |
| `violations-critical` / `-high` / `-medium` / `-low` | Counts across every scanned URL. |
| `total-issues` | Total findings reported as violations. |
| `manual-review-count` | Findings that need a human look rather than counting as violations. |
| `warnings-count` | Scan warnings that make the result unrepresentative. |
| `engines-used` | Comma-separated engines that actually ran. |
| `sarif-file` / `results-file` | Absolute paths of the files written, when requested. |

## Permissions

```yaml
permissions:
  pull-requests: write   # required to post or update the comment
  id-token: write        # recommended; buckets free-tier quota per repository
```

Both are optional. Without `pull-requests: write` you get a warning and
the job summary. Without `id-token: write` the scan still runs, but
free-tier quota is bucketed by the runner's egress IP, which
GitHub-hosted runners share with every other repository behind the same
NAT address.

Pull requests from forks receive a read-only token by design, so the
comment is skipped there. That is expected, and it never fails the
build.

## How the gate works

The verdict is computed by the scanner, not by this action. The action
sends your thresholds; the backend applies them to the same finding list
the hosted report shows, and returns the verdict. This matters because
two categories of finding appear in the report but deliberately do not
gate a build:

- **Framework-managed markup.** Component-library portals, consent
  widgets, reCAPTCHA and Turnstile frames, streaming-SSR artifacts. You
  cannot fix these in your own code, so failing your build on them asks
  the impossible.
- **Rules that are not success criteria.** Best-practice rules with no
  WCAG criterion behind them, and 4.1.1, which WCAG 2.2 removed.

Both are disclosed in the comment rather than silently dropped. Before
v2 the action recomputed its own verdict from severity counts and could
therefore fail a build the report called a pass. There is now one gate.

## When a scan is not representative

A bot-detection challenge, a full-page consent dialog, or an HTTP block
means the engines analysed an interstitial rather than your page. A
near-clean score on one of those says nothing about your site, so by
default it fails the build with an explanation rather than passing.

The same applies when the false-positive filtering or the confidence
scoring did not complete: the findings are then raw engine output, and
saying so is more useful than a number that looks authoritative.

Set `fail-on-unrepresentative: false` to treat these as advisory. They
are always shown either way.

## Free tier

Without a token:

- **10 scans per day per repository**
- **10 scans per hour**, so an accidental loop cannot drain the day's
  allowance in minutes

Add `permissions: id-token: write` so the quota is attributed to your
repository through a signed GitHub OIDC token rather than to a shared
runner IP.

## With a token

Supply `accessibility-pro-token` and scans are attributed to your
account rather than run anonymously. That means they appear in your
dashboard and history next to your interactive scans, and they draw on
your plan's **CI allowance**, which is a separate budget from your
monthly interactive scans:

| Plan | CI scans / month |
|---|---|
| Free (anonymous) | 10 per day per repository |
| Solo | 1,000 |
| Team | 5,000 |
| Business | 20,000 |

CI is metered separately because it is a different workload: a CI scan
is a single page, where an interactive scan crawls your site and pays
for AI enrichment. Charging one against the other would have made a
paid plan worth fewer CI scans than the free tier.

The action prints the remaining allowance on each run and warns at 90%.
Copy-as-PR fixes are generated in the hosted report and need you signed
in there; the token does not carry into that surface.
See [accessibilitypro.app/pricing](https://www.accessibilitypro.app/pricing).

## Why this is different

Every **Copy as PR** diff is sandbox-validated before you are offered
it: the patch is applied to the captured DOM, the page is re-scanned,
and the diff is only labelled Verified when it resolves the violation
without introducing new ones. When no safe patch exists you get a
snippet marked for manual review instead of a broken diff.

Findings carry their evidence level, from `verified by interaction`
(the keyboard walker actually got trapped) down to `single engine`
(reported once, not corroborated). Text written by AI is labelled as
such and never mixed with an engine's own words.

See the published
[accuracy benchmark](https://www.accessibilitypro.app/benchmark) for
reproducible precision and recall against axe-core alone.

## Anti-overlay

We do not sell overlay widgets. Overlays cannot bring a site into WCAG
compliance: they change what a scanner sees, not what a person using
assistive technology experiences. We fix code, not the appearance of
code.

## Upgrading from v1

`url`, `wcag-level`, `fail-on`, `accessibility-pro-token`,
`backend-url` and `report-domain` are unchanged, and `comment-on-pr`
still works. For most repositories, changing `@v1` to `@v2` is the whole
migration.

Three behaviours changed on purpose:

1. **The scanner owns the verdict.** Builds that failed on
   framework-managed findings now pass, matching the report.
2. **Comments are sticky.** One comment per pull request, updated in
   place. Use `comment: new` for the old behaviour.
3. **An unrepresentative scan fails.** Use
   `fail-on-unrepresentative: false` for the old behaviour.

The action also no longer runs `actions/setup-node` in your job, so it
cannot change the Node version your other steps see.

See [CHANGELOG.md](CHANGELOG.md) for the full list.

## Development

```bash
node test/e2e.mjs
```

The suite spawns the action against a mock backend and a mock GitHub
API and asserts on exit codes, outputs, job-summary markdown and the
comment body. There is no build step and no `node_modules`: what CI
runs is what your runner executes.

## License

[MIT](LICENSE). The action is open source; the scanning service it
calls is a hosted product with its own terms.
