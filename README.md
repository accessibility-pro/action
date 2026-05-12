# Accessibility Pro · GitHub Action

Free WCAG 2.2 AA scanner that runs on every PR. Posts an impact-ranked
comment with a deep link to **Copy as PR**: a validated unified diff
that resolves the violation without regressions.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![accessibilitypro.app](https://img.shields.io/badge/accessibilitypro.app-green)](https://www.accessibilitypro.app)

## Usage

```yaml
# .github/workflows/a11y.yml
name: Accessibility scan
on: [pull_request]

jobs:
  a11y:
    runs-on: ubuntu-latest
    steps:
      - uses: accessibility-pro/action@v1
        with:
          url: ${{ secrets.STAGING_URL }}
          wcag-level: AA        # A | AA | AAA
          fail-on: error        # error | warning | none
          # Optional: unlocks Team-quota and Copy-as-PR in PR comments
          accessibility-pro-token: ${{ secrets.ACCESSIBILITY_PRO_TOKEN }}
```

> **Pre-publication form**: until `accessibility-pro/action@v1` is live
> on the Marketplace, you can pin the source repo directly:
>
> ```yaml
> - uses: HasanTayem/access-pro-ai/action@main
> ```
>
> Both forms call the same code; only the discoverability via
> Marketplace search differs.

## Inputs

| Input | Default | Description |
|-------|---------|-------------|
| `url` | *(required)* | URL to scan. For auth-gated previews, store as a repo secret. |
| `wcag-level` | `AA` | `A`, `AA`, or `AAA`. |
| `fail-on` | `error` | `error` (critical + high violations fail CI), `warning` (adds medium), or `none`. |
| `accessibility-pro-token` | `''` | Optional API token. Unlocks Team-quota scans and Copy-as-PR in comments. |
| `comment-on-pr` | `true` | Post the results as a PR comment on `pull_request` events. |
| `backend-url` | Prod | Override for the backend API (self-hosted deployments). |
| `report-domain` | Prod | Override for the hosted-report domain (self-hosted frontend). |

## Outputs

| Output | Description |
|--------|-------------|
| `scan-id` | UUID of the scan; use to build your own deep links. |
| `score` | Accessibility score (0 to 100). |
| `violations-critical` | Count of critical-severity violations. |
| `violations-high` | Count of high-severity violations. |
| `report-url` | Direct link to the hosted report. |

## Free tier

Without a token:

- **10 scans per day per repository**. Enough to dogfood the workflow
  on every PR before committing to a paid plan.
- **10 scans per hour** burst protection prevents an accidental loop
  from exhausting the daily allowance in minutes.

With a token, your Team ($99/mo) or Business ($399/mo) plan quota
applies. Sign up at
[accessibilitypro.app/pricing](https://www.accessibilitypro.app/pricing).
A token also unlocks **Copy-as-PR** validated diff comments on PRs.

## Why this is different

Every **Copy as PR** diff is sandbox-validated before emission. We apply
the patch to the captured DOM, re-run axe on the patched output, and
only mark the patch **Verified** if it resolves the violations without
introducing new ones. When the generator cannot produce a safe diff, we
hand you a code snippet labelled *Needs manual review* instead of a
broken patch. See our published
[accuracy benchmark](https://www.accessibilitypro.app/benchmark) for
reproducible precision / recall numbers vs axe-core.

## Anti-overlay

We do not sell overlay widgets. Overlays alone cannot bring a site
into WCAG compliance. The FTC fined accessiBe $1M in January 2025 for
exactly that claim; 22% of 2025 ADA web lawsuits name overlay-using
defendants. We fix code, not the appearance of code.

## License

MIT.
