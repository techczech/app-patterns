---
title: Repair shared command contracts required by MediaWell
created: 2026-10-23
status: implemented-awaiting-astra-review
register: FOR AGENTS
---

# MediaWell command contract repairs

- Derived from Astra review of MediaWell be3f762..3057f3a: source keyboard policy, reserved-command rebinding, native menu ordering and exact verified Electron compatibility.
- Scope: commands implementation/tests and settings-electron compatibility metadata; affected release versions/manifest and directly related contract documentation.
- Existing immutable releases remain unchanged. Generate new versioned packages through repository release tooling; no npm or public GitHub Release publication.
- Own repository only. Another Sol builder is working in the separate MediaWell repository; do not change it from this task.
- Parent will inspect/commit these changes and have MediaWell consume the corrected immutable artefacts during its shell repair slice, then request Astra re-review.


## Implementation handoff — 2026-10-23

- Agent: Sol, implementation sub-agent; no delegation.
- Base: `481bcc1b5f1dde380dc174bbe7bffc90ab8e945b` on `fix/mediawell-command-contracts`.
- Sole edited repository: App Patterns. Source left uncommitted; no push, npm publication, public release or `release:pack` run.
- Astra review remains required. No unresolved framework source conflict identified.

### Corrected contracts

- Registry opt-in: `defineRegistry(commandDefs, { rebindableEstateDefaults: true })`.
- Define each estate command with its reserved default `key`; pass saved choices as overrides. Retain MediaWell's existing ids, labels, typing/scopes/availability and flags. Framework supplies Settings and cheat sheet. No application resolver or frozen-definition mutation needed.
- With opt-in, all nine estate holders can move/unbind, including input definitions marked `fixed`. Frozen copied definitions omit `fixed`, exposing the correct bindable state to Settings. Original inputs remain untouched. Original estate chords remain reserved for their declared holder in every scope, including after moving/unbinding. Owners can return to their own default. Duplicate ownership across scopes is refused.
- Existing explicit non-estate fixed commands retain fixed bindings and reserve their own chords. Callers omitting the option retain legacy estate fixed behaviour. Default overlay membership preserves estate holders after rebinding; explicit overlay sets remain authoritative.
- Added the missing `⌘⇧,` estate reservation for rebinding.
- Shared `chordRestriction` rejects full hyper and plain Control+left/right/up/down, with Raycast or Mission Control/Spaces refusal text. Both definition validation (including fixed defaults) and `checkRebind` call it; saved overrides, Settings operations/import and CLI all use registry validation through the existing adapter. Chord grammar/accelerator conversion remain representation functions. Control+Command arrows, Control+Command+Shift subtree arrows and other non-conflicting modifier combinations remain available.
- Menu frame: App, Edit, View, app-specific menus, Window, Help. Effective accelerators, display-only registration, availability, scope behaviour, frame commands and complete menu coverage retained.

### Versions and package graph

- `@app-patterns/commands`: 0.4.1 → **0.4.2**.
- `@app-patterns/settings-electron`: 0.4.1 → **0.4.2**. Electron peer: `>=30 <43 || 44.7.2`. Commands and Settings React peers: `^0.4.2`; Settings remains `^0.4.1`.
- `@app-patterns/settings-react`: 0.4.1 → **0.4.2**, metadata only; Commands peer `^0.4.2`. Required because Bun materialises workspace devDependency versions in packed manifests: changing Commands changes Settings React's released contents even with unchanged renderer code.
- Settings, Outline, Updates and Updates React remain **0.4.1**. Throwaway packs match their recorded immutable contentsDigest values exactly. No unrelated dependency resolutions changed in `bun.lock`.
- All three 0.4.2 versions were absent from `releases/manifest.json` and local release archives. Temporary packs validated complete promised exports, no forbidden files/unresolved workspace ranges and coherent framework peer ranges; built Commands entry points passed the registry/menu/event probe.
- `releases/manifest.json` and existing archives deliberately unchanged. Parent must generate provenance only after reviewing/committing source, from a clean checkout.

### Regression evidence and checks

Bun: **1.3.10** throughout. Added tests before production changes.

- `bun test packages/commands packages/settings-electron/src/install.test.ts`: baseline **106 passed, 12 failed**. Failures reproduced fixed estate bindings, dropped saved choices, keyboard dispatch, platform acceptance, menu order and Electron peer exclusion.
- `bun test packages/settings/src/commands-adapter.test.ts packages/settings/src/node/cli.test.ts`: corrected baseline **21 passed, 3 failed**. Reproduced migration/load/import/CLI refusal of valid estate overrides; the import/rebind cases also exercise platform refusal after the shared fix.
- `bun test packages/commands packages/settings/src/commands-adapter.test.ts packages/settings/src/node/cli.test.ts packages/settings-electron/src/install.test.ts`: **142 passed, 0 failed** after fixes.
- `bun run --cwd packages/commands check`: **73 passed**, typecheck/build passed.
- `bun run --cwd packages/settings check`: **179 passed**, typecheck/build passed.
- `bun run --cwd packages/settings-electron check`: **80 passed**, typecheck/build passed.
- `bun install --lockfile-only --ignore-scripts`, then `bun install --frozen-lockfile --ignore-scripts`: passed; lock changes limited to the three workspace versions and affected peer metadata.
- Initial dependency build found missing Updates workspace links despite a normal install reporting no changes. `bun install --frozen-lockfile --ignore-scripts --force` restored declared dependencies; subsequent package/workspace checks passed. No tooling or dependency version migration.
- Final `bun run check`: **692 passed, 0 failed**, all package typechecks/builds and release-tool tests passed. Breakdown: Commands 73; Outline 109; Settings 179; Updates 21; Updates React 6; Settings React 116; Settings Electron 80; release tooling 108.
- `bun run scripts/check-electron-compatibility.mjs`: passed against official exact Electron 44.7.2 declarations, without the package's ambient shim. Checks host/app, IPC, cipher, renderer bridge, navigation listeners, BrowserWindow options and generated MenuItem types. Downloads only the npm package/declaration, never installs/launches Electron; fixtures removed in `finally`.
- Declaration source: `https://registry.npmjs.org/electron/44.7.2`; archive `https://registry.npmjs.org/electron/-/electron-44.7.2.tgz`; verified SRI `sha512-u3Pbz0Hi1sSSwBMz2v8LiagsfUG4QURPUe/qphM+g4THKP8o4BYdnuboyhlLO8HIC/KfV5rvltyacbP4jEq9yw==`.
- `git diff --check`: passed. Working checkout Git index and HEAD unchanged.

The final full check uses the existing temporary-fixture helper around `bun run check` so nested package tests share one owned root; the wrapper removes that root in `finally`. Earlier direct checks emitted the existing temp-sweep warning; no potentially unrelated folders were removed. Reproduce the final isolated run from the framework root:

```sh
bun - <<'JS'
import { tempDir } from './scripts/release-test-fixtures.mjs';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
const dir = tempDir('release-test-mediawell-workspace-');
try {
  const result = spawnSync(process.execPath, ['run', 'check'], {
    env: { ...process.env, TMPDIR: dir, TEMP: dir, TMP: dir, APP_PATTERNS_TESTRUN_ROOT: dir },
    stdio: 'inherit',
  });
  process.exitCode = result.status ?? 1;
} finally { rmSync(dir, { recursive: true, force: true }); }
JS
```

### Parent review, pack and vendor

1. Have Astra review the uncommitted framework diff. Parent reviews and commits validated source; retain any review repairs in new immutable bytes before first pack.
2. From the **clean committed framework checkout**:

   ```sh
   bun install --frozen-lockfile
   bun run check
   bun run release:pack
   ```

   Use the full pack: this checkout lacks some recorded 0.4.1 tarballs. The owning tool recreates matching unchanged archives and adds the three new 0.4.2 records without changing older released contents. Parent owns the generated manifest commit.

3. Parent sets `mediawell_root` to its verified MediaWell checkout and ensures the app manifests/vendor files meet the vendor tool's clean/committed preconditions. From App Patterns:

   ```sh
   bun run release:vendor "$mediawell_root"
   bun run release:vendor "$mediawell_root" --write
   ```

4. In MediaWell, enable the registry option, consume Commands/Settings React/Settings Electron 0.4.2 with Settings 0.4.1, remove the blanket `legacy-peer-deps` flag, and update its existing npm lock normally. Do not migrate MediaWell to Bun or downgrade Electron.
5. Parent repeats real-Electron integration on **44.7.2** after vendoring, then requests Astra acceptance. The ten earlier real-Electron journey groups and mocked native encryption are parent-reported context, not rerun here. No app launch, native keychain check or packaged-runtime check performed by this sub-agent. MediaWell-local findings 1–3 remain with the separate repair task.

## Astra framework review round one

- Reviewed481bcc1..4def24a. Spec: one P3 defect; Standards: none. Independent targeted suite142/142 and1007 assertions; scope/limits in research/2026-10-23-astra-review-of-mediawell-command-contract-repairs-round-one.md.
- Existing Shortcuts conflict UI offers Swap for a newly rebindable Settings default. Swapping Settings defaultCmdComma with Refresh CmdR proposes giving reservedCmdComma to Refresh; shared store correctly refuses. UI must validate the whole batch and offer only valid actions.
- Next Sol repair: renderer/shared-resolver guard with a real settings-operation regression. Preserve valid Replace and custom/custom swaps. No package artefacts packed yet;0.4.2 remains unused and may include this pre-release repair.
