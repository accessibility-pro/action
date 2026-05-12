# Changelog · Accessibility Pro Action

All notable changes to the GitHub Action ship here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [SemVer](https://semver.org).

## [Unreleased]

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

### Notes
- Pre-publication usage: pin `HasanTayem/access-pro-ai/action@main`
  until Marketplace publication completes.
