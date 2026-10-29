---
title: "App Patterns public release preparation 2026-10-29"
kind: "evidence"
created: "2026-10-29T17:08:04Z"
project: "/Users/dominiklukes/gitrepos/06_apps-utilities/03_misc-utilities/app-patterns"
sources:
  - file: releases/manifest.json
  - file: docs/release-app-patterns-0.4.4.md
---
# App Patterns public release preparation — 29 October 2026

Prepared by Codex gpt-6.1-sol. Status: candidate only; parent independent review and publication remain outstanding. Scope is this repository only. No subagents, commit, push, tag, npm publication, visibility change or deployment occurred. The personal website was not touched. No branch was merged and no new exporter or write mechanism was introduced.

## Baseline and public state

Initial clean main: dff2798c8a50c6a40f7bf94459cb3ee2713a53d3. `git pull --ff-only` exited 0, already up to date. GitHub repository metadata confirms PUBLIC, MIT, default main, has_pages false. Pages API returned 404 (exit 1). Latest public release remains v0.4.1, published 2026-10-21T08:06:24Z; earlier v0.3.0, published 2026-10-20T21:03:02Z. The JSON evidence records exact public asset names. No private-history projection is needed: repository source and history are already public.

## Candidate and necessary version changes

Commands 0.4.2 failed release:pack because its README had changed after packing. A diagnostic archive comparison found README.md was the only changed entry before its patch bump. Commands advances to 0.4.3. The next pack failed on settings-react 0.4.2: Bun resolved the workspace settings development dependency to 0.4.2 instead of the archived 0.4.1. Settings React advances to 0.4.3 and Settings Electron to 0.4.4 for the resulting workspace metadata changes. Final comparisons show identical dist files for all three packages; only package.json and the command README differ. All historical released manifest records are unchanged. No source implementation changed.

The proposed framework collection is v0.4.4. The independent package inventory is commands 0.4.3, settings 0.4.2, settings-react 0.4.3, settings-electron 0.4.4, updates 0.4.1, updates-react 0.4.1 and outline 0.4.1. The final pack preserved existing archive bytes. New manifest records honestly retain baseline commit plus commitDirty true, because these are uncommitted preparation changes. Do not rewrite that provenance as clean-commit evidence.

## Validation and exact evidence

- Bun version: 1.3.10. Initial and final `bun install --frozen-lockfile` exited 0. `bun install` after the version changes exited 0; bun.lock changes only the three workspace versions.
- Initial `bun run check` exited 0. Its build overlapped the initial pack; it is superseded by the final sequential check.
- Initial `bun run release:pack` exited 1 at commands immutability; the next attempt exited 1 at settings-react immutability. Both failure logs are retained. A diagnostic relative-destination `bun pm pack` failed to open its destination; the absolute in-repository retry succeeded. Diagnostic archives were removed.
- Final `bun run release:pack` exited 0, followed sequentially by final `bun run check`, exit 0. The logs preserve each package's typechecks/tests/build and release tooling tests. Tests use doubles; no installed desktop app/native UI acceptance is claimed. Existing test cleanup diagnostics mention folders outside the per-run root that may belong to other sessions; none were removed by this preparation.
- `bun audit --json` exited 0 with `{}`. GitHub Dependabot alerts API returned 403, exit 1: alerts disabled; this is not an empty-alert verdict. No security settings or credentials were changed. No fleet catalogue security harvest was run because the task restricts writes to this repository; the direct locked dependency audit supplies the focused check.
- Artifact helper verification exited 0 for all seven archives: SHA-512 integrity, content digests, promised export files and forbidden-content policy. Independent inline Python inspection recorded every member path, size and SHA-256, checked expected distribution paths and private-home/credential-shaped content, and compared preceding archives. No matches were found; this is a bounded content inspection, not a claim of exhaustive secret detection.
- Every packed manifest declares MIT. Five archives include LICENSE. The two unchanged update archives lack licence text; ship the root LICENSE as a separate asset and retain it with vendored copies. Parent review must assess this distribution limitation before publication; immutable 0.4.1 archives were not modified.
- `git diff --check` exited 0. The Pages source has seven package links and installation guidance; no HTML renderer, local Jekyll build or deployed-page test was run. Pages deployment and live verification remain parent steps.

The exact distributable inventory, per-file archive hashes and current package versions are in `release-preparation-2026-10-29/artifact-inventory.json`. `releases/SHA256SUMS` covers exactly seven tarballs, manifest.json and LICENSE. Manifest SHA-256: bca2d47f1137e72749bedba52938e49f9f86f29419675a0fdd0dc698ad9d5748. Candidate file hashes are recorded separately; the receipt and hash file do not hash themselves.

## Changed paths and parent handoff

- `CHANGELOG.md`
- `README.md`
- `bun.lock`
- `docs/_config.yml`
- `docs/index.md`
- `docs/release-app-patterns-0.4.4.md`
- `packages/commands/package.json`
- `packages/settings-electron/package.json`
- `packages/settings-react/package.json`
- `releases/SHA256SUMS`
- `releases/manifest.json`
- `research/release-preparation-2026-10-29/archive-comparison.log`
- `research/release-preparation-2026-10-29/artifact-inventory.json`
- `research/release-preparation-2026-10-29/artifact-validation.log`
- `research/release-preparation-2026-10-29/audit.json`
- `research/release-preparation-2026-10-29/audit.stderr`
- `research/release-preparation-2026-10-29/check-final.log`
- `research/release-preparation-2026-10-29/check.log`
- `research/release-preparation-2026-10-29/github-alerts.json`
- `research/release-preparation-2026-10-29/github-alerts.stderr`
- `research/release-preparation-2026-10-29/github-pages.json`
- `research/release-preparation-2026-10-29/github-pages.stderr`
- `research/release-preparation-2026-10-29/github-releases.json`
- `research/release-preparation-2026-10-29/github-repository.json`
- `research/release-preparation-2026-10-29/install-candidate.log`
- `research/release-preparation-2026-10-29/install-final.log`
- `research/release-preparation-2026-10-29/install.log`
- `research/release-preparation-2026-10-29/pack-candidate.log`
- `research/release-preparation-2026-10-29/pack-final.log`
- `research/release-preparation-2026-10-29/pack.log`

Additional evidence files: this Scout receipt and `research/release-preparation-2026-10-29/candidate-file-hashes.json`. Ignored release tarballs are retained for the parent to upload; diagnostic scratch has been removed. The working tree intentionally contains the reviewable candidate, with no commit or push as requested.

`docs/release-app-patterns-0.4.4.md` contains the release body, exact ten-asset upload command and concrete parent-only publication steps. `docs/index.md` and `docs/_config.yml` prepare the Pages branch/docs configuration using GitHub's Cayman theme. README and page copy derive from existing package descriptions and source; reviewed locally for factual fidelity, clear instructions and unsupported claims. This is author self-check only; independent editorial, release and page review belongs to the parent. The parent must review the version changes, licence limitation, full diff and evidence, then commit/tag/push/publish and enable Pages under its publication authority. It separately owns website Frameworks and catalogue updates.
