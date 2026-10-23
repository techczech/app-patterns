---
title: Repair shortcut conflict swaps required by MediaWell
created: 2026-10-23
status: implemented-awaiting-parent-and-astra-review
register: FOR AGENTS
agent: Sol
---

# Shortcut swap repair

- Sole write target: App Patterns, branch `fix/mediawell-command-contracts`.
- Base and unchanged HEAD: `0f2406b6cdb3791c5dad5433aa64db84c8e51149`.
- Input: Astra round-one report in `research/2026-10-23-astra-review-of-mediawell-command-contract-repairs-round-one.md`; sole P3 Spec finding. No Standards findings supplied.
- Source left uncommitted. Index untouched. No delegation, checkout creation, visible app launch, package packing/publication, commit or push. No other repository edited.

## Repair

- `packages/settings-react/src/pages-shortcuts.tsx`: preview both complete Swap and Replace batches using the existing pure Settings `rebindMany`, `commandsAdapter` and real registry resolver against the current state. Discard proposed state and changelog; use local inert clock/id callbacks. Never call host actions during preview.
- Invalid action disabled; inline explanation uses the operation's resolver message. Valid Replace retained for Settings/CmdComma versus Refresh/CmdR. No command-id or chord special case.
- Preview re-evaluates each render using the current effective source chord, current holder and current complete saved overrides. Event handlers submit the corresponding validated batch. Actual host/store operation still validates its latest state independently.
- `packages/settings-react/src/types.ts`: `SettingsRegistry.resolveBindings` retains the rejection list required by `RegistryLike`, using that existing exported type. Real `defineRegistry` results already satisfy this. Custom registry wrappers must retain `rejected` instead of dropping it.
- `packages/settings-react/README.md`: documents conflict previews, disabled actions, reserved return chord and rejection-list contract.
- Commands registry/platform rules, menu builder and Settings operations unchanged. Earlier seven correction contracts retained; full workspace tests cover their existing regressions.

## Regression

- New `packages/settings-react/src/shortcut-conflicts.test.tsx`: eight renderer tests, real recorded keyboard events, real `defineRegistry`, `commandsAdapter`, `rebindMany` and `loadState`. Host callback applies the actual operation and rerenders its returned state; no mocked success for shortcut writes.
- Settings and cheat-sheet reserved defaults: disabled Swap, exact operation explanation, enabled Replace, no disabled-action submission; Replace survives JSON persistence/reload.
- Two custom/unreserved swaps, including moved Settings: effective results, common batch history and persistence/reload retained.
- Open conflict follows changed return chord and changed target holder, retains unrelated saved overrides, enables/disables Swap again after further state changes.
- Preview changes neither input state/history nor host id count/actions. Fixed-holder refusal retained. A separate writer can invalidate the rendered preview; actual operation refuses the stale batch atomically and the renderer displays its error.

## Commands and results

Bun `1.3.10` throughout; existing workspace/lock used.

1. `bun test packages/settings-react/src/shortcut-conflicts.test.tsx`
   - Initial test-authoring run: 2 passed, 6 failed, 32 assertions. Corrected two assumptions against observed existing semantics: fixed holders already use the reserved refusal; collision fallback may name Refresh rather than Pin.
   - Corrected red baseline before production edits: **4 passed, 4 failed, 37 assertions**, exit 1. All four failures: enabled Swap where complete batch is invalid, including state re-evaluation.
   - After production fix: **8 passed, 0 failed, 66 assertions**, exit 0; no warnings.
2. `bun run --cwd packages/settings-react typecheck`: exit 0.
3. `bun run check`, inside existing temporary-fixture wrapper below: **700 passed, 0 failed, 7,047 assertions**, exit 0. All workspace builds/typechecks and release-tool tests passed.
   - Commands 73; Outline 109; Settings 179; Updates 21; Updates React 6; Settings React 124; Settings Electron 80; release tooling 108.
   - Ten React `act(...)` warnings emitted while running existing `settings-window.test.tsx` tests. New conflict test emitted none. No warning suppression or unrelated test edits.
   - Raw output: `research/2026-10-23-sol-shortcut-swap-repair-check.log`.
   - Log SHA-256: `9a1d030212c1a38eb46b7a5a117681e4944ef3437885260579beb03d2931f452`.
4. `git diff --check`: exit 0. `git diff --cached --name-only`: empty. HEAD unchanged.

Exact full-check wrapper (run from App Patterns root):

```sh
bun - <<'JS'
import { tempDir } from './scripts/release-test-fixtures.mjs';
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
const dir = tempDir('release-test-mediawell-shortcut-swap-');
try {
  const result = spawnSync(process.execPath, ['run', 'check'], {
    env: { ...process.env, TMPDIR: dir, TEMP: dir, TMP: dir, APP_PATTERNS_TESTRUN_ROOT: dir },
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const log = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  writeFileSync('research/2026-10-23-sol-shortcut-swap-repair-check.log', log);
  console.log(log.split('\n').filter(line => /pass$|fail$|expect\(\)|Ran .*tests|error:|TS\d|warning/i.test(line)).join('\n'));
  console.log(`workspace check exit: ${result.status}; signal: ${result.signal ?? 'none'}`);
  process.exitCode = result.status ?? 1;
} finally { rmSync(dir, { recursive: true, force: true }); }
JS
```

## Package set and immutable releases

- Only Settings React source/types change in this repair. Its already unused **0.4.2** includes these bytes; no additional bump needed.
- Coherent pending set remains Commands **0.4.2**, Settings React **0.4.2**, Settings Electron **0.4.2**, Settings **0.4.1**. Outline, Updates and Updates React remain **0.4.1**.
- Confirmed all three 0.4.2 versions absent from `releases/manifest.json`. Commands/Settings React peers remain `^0.4.2`; Settings peer remains `^0.4.1`; Electron peer remains `>=30 <43 || 44.7.2`.
- No package manifests, `bun.lock`, released manifest or archives changed. No other released 0.4.1 package source/build input changed. No pack performed; packed metadata/provenance remains for the parent's clean accepted source.

## Parent handoff and limits

- Review complete uncommitted diff, including untracked regression, task record and research evidence. Pin accepted source in a new commit, then request Astra re-review. Parent owns clean-source packing and MediaWell vendoring.
- No new Electron declaration check, actual Electron/runtime/native-keychain check, native packaging or MediaWell acceptance performed. Earlier declaration evidence remains in the original task report. Regression persistence uses actual JSON serialization and `loadState`, not disk-store IO.
- This completes implementation only; independent acceptance remains pending.
