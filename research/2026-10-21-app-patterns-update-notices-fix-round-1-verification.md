---
title: "App Patterns update notices fix round 1 verification"
kind: "evidence"
created: "2026-10-21T00:19:40Z"
project: "/Users/dominiklukes/gitrepos/06_apps-utilities/03_misc-utilities/app-patterns.worktrees/updates"
sources:
  - url: "https://github.com/techczech/app-patterns/tree/feat/updates"
---
All six App Patterns update-notices review items are fixed:
1. Core comments now describe an app store, host-owned persisted state and the app reporting itself busy.
2. The main-side checker reads process.arch by default or accepts an injected architecture; snapshots distinguish Apple silicon and Intel Mac copy facts.
3. createUpdateLinkOpener binds the shell, identity, platform and latest-state reader in main. Calls accept a kind and optional version, never an address. It revalidates persisted feed entries, checks version matches, rejects unsupported download platforms, validates configured HTTPS store links and catches browser failures. Documentation and the TalkWeaver-shaped host example use it.
4. The base Settings entry no longer imports either updates package. The rich card is exported from @app-patterns/settings-react/updates and supplied through updateCard. Both update peers are optional. Release packing and vendoring exclude optional peers from the required closure. An integration test vendors a Settings-only app with no updates tarballs present.
5. The Electron host declares canCheckForUpdates in its view only when a checker was installed. The legacy About button requires that capability plus its action. Rejections go through the normal visible Settings notice. Regression tests cover an old host with no checker and a rejecting checker.
6. Tests reject javascript:, file:, data: and http links in all three feed URL fields.

Verification:
- bun test packages scripts: 674 pass, 0 fail, 6773 expect() calls, 39 files.
- bun run typecheck: exit 0; all seven packages built and typechecked.
- bun install --frozen-lockfile --ignore-scripts: checked 94 installs across 89 packages, no changes.
- gitleaks dir --redact --no-banner: no leaks found; scanned about 1.80 MB.
- Base Settings entry bundled independently; no @app-patterns/updates imports in the bundle.
- Privacy scan covered updates core/React and the changed Settings bridge/host. The one feed request uses a fixed app name, omitted credentials and refused redirects. The new browser opener receives no renderer URL. No new telemetry, user/device identifier or private path was found. Existing host-name use is confined to an explicit local Settings export. The changed-file private-path/institutional-name scan found no matches.

No app launch, signing, keychain command, public PR or npm publication was performed for App Patterns. Existing local release tarballs were not regenerated; this commit changes source and release tooling.
