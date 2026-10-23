---
title: "Astra acceptance of MediaWell command contract repairs round two"
kind: "evidence"
created: "2026-10-23T13:22:43Z"
project: "/Users/dominiklukes/gitrepos/06_apps-utilities/03_misc-utilities/app-patterns"
sources:
  - file: _TASK-LOG/task-mediawell-shortcut-swap-repair.md
---
Attributed review by Astra (gpt-6-astra), 23 October 2026. Full wording retained; line-end whitespace normalised. The verdict is scoped to the exact revisions and verification limits below.

No action needed. **App Patterns framework review round two passes: the previous P3 is repaired, with no new actionable Spec or Standards findings. The pinned framework source may proceed to clean-source packing.** This does not accept MediaWell’s package consumption or native runtime integration.

Reviewed repository: `/Users/dominiklukes/gitrepos/06_apps-utilities/03_misc-utilities/app-patterns`, on `fix/mediawell-command-contracts`.

Exact reviewed ranges:

```text
Shortcut-swap repair:
0f2406b6cdb3791c5dad5433aa64db84c8e51149..f31633ebaa1f65cc4b38400bc1e5090688430bbf

Overall framework repair:
481bcc1b5f1dde380dc174bbe7bffc90ab8e945b..f31633ebaa1f65cc4b38400bc1e5090688430bbf
```

All source references below identify the pinned head. HEAD and index remained unchanged; the checkout remained clean.

**Spec: prior P3 disposition**

**Resolved.** Settings no longer offers an enabled Swap that would give its reserved default chord to Refresh.

In [pages-shortcuts.tsx:45](/Users/dominiklukes/gitrepos/06_apps-utilities/03_misc-utilities/app-patterns/packages/settings-react/src/pages-shortcuts.tsx:45), both complete proposed batches pass through the existing `rebindMany` operation, `commandsAdapter` and registry resolver using the current Settings state. Invalid Swap is disabled, its operation error appears inline, and valid Replace remains enabled. The same behaviour covers the cheat-sheet default.

The preview is pure with the real registry. The Settings commit operation copies the settings and shortcut maps, validates the resulting set, and constructs new history rather than changing the input ([state.ts:108](/Users/dominiklukes/gitrepos/06_apps-utilities/03_misc-utilities/app-patterns/packages/settings/src/state.ts:108)). Preview timestamps and IDs come from inert local callbacks; proposed state and history are discarded.

**Spec: new findings**

None found.

The renderer regressions exercise recorded keyboard events, real resolution, actual Settings operations and JSON serialisation followed by `loadState`. They establish:

- Reserved Settings and cheat-sheet swaps are disabled without submitting host actions, while Replace persists.
- Custom/custom swaps and swaps involving Settings moved to an unreserved chord succeed with shared batch history.
- An open conflict follows changes to its current holder and return chord, preserving unrelated overrides.
- A concurrent change that invalidates the submitted batch is refused atomically, with the error displayed.

These cases are in [shortcut-conflicts.test.tsx:46](/Users/dominiklukes/gitrepos/06_apps-utilities/03_misc-utilities/app-patterns/packages/settings-react/src/shortcut-conflicts.test.tsx:46). The explanation is visible text within `role="alert"`; Swap and Replace use native disabled buttons. Screen-reader announcement and visual layout were not independently exercised.

**Standards findings**

None found in the reviewed scope.

The repair reuses the existing operation and resolver. It introduces no host/IPC operation or parallel validation implementation.

The strengthened [SettingsRegistry type:23](/Users/dominiklukes/gitrepos/06_apps-utilities/03_misc-utilities/app-patterns/packages/settings-react/src/types.ts:23) requires the resolver’s rejection list. Real `defineRegistry` results already satisfy it, and the renderer typecheck passes. **Custom wrappers that previously returned only `bindings` must now retain `rejected`.** This is a documented compatibility requirement, not universal compatibility with every previously permitted wrapper.

Commands, Settings React and Settings Electron remain at unused `0.4.2`; Settings remains `0.4.1`. Source peer ranges are coherent. Existing release records and tracked artefacts are unchanged, with no `0.4.2` manifest entries. No vault-files or Updates changes occur in the overall range.

The Electron peer remains narrowly bounded to `>=30 <43 || 44.7.2`. The declaration-check script verifies archive integrity and API type compatibility; it does not prove native runtime compatibility.

**Inspected non-findings**

- The nine estate holders remain movable and unbindable, their original chords remain reserved, and owners can return to their defaults. Original inputs, frozen definitions, legacy fixed behaviour and explicitly fixed non-estate commands remain intact.
- Saved overrides, scope handling, collision fallback, keyboard dispatch and overlay behaviour retain their existing contracts.
- Hyper and plain Control+arrow bindings remain refused through the shared registry, Settings adapter, import and CLI paths. Control+Command structural arrows remain accepted.
- Generated menus retain App, Edit, View, application menus, Window, Help ordering, effective accelerators and coverage.

**Independent verification**

I ran the following using the established temporary-fixture wrapper, with cleanup in `finally`:

```sh
bun test packages/settings-react/src/shortcut-conflicts.test.tsx \
  packages/commands \
  packages/settings/src/commands-adapter.test.ts \
  packages/settings/src/node/cli.test.ts \
  packages/settings-electron/src/install.test.ts
```

Result: **150 passed, 0 failed, 1,073 assertions**, exit 0. This includes the eight new renderer regressions.

I also independently ran:

```sh
bun run --cwd packages/settings-react typecheck
```

Result: exit 0. Both reviewed ranges passed `git diff --check`.

I inspected Sol’s verification receipt and raw-log results. The log’s SHA-256 matches:

```text
9a1d030212c1a38eb46b7a5a117681e4944ef3437885260579beb03d2931f452
```

**Verification limits and handoff**

Sol’s full **700-test workspace run, builds, earlier Electron declaration check, temporary-pack comparisons and red-before-fix results remain builder evidence**. I did not rerun those checks. The raw log discloses ten existing React `act(...)` warnings.

I installed nothing, edited nothing, packed nothing and launched no app or native Keychain operation. The new renderer persistence checks cover JSON plus the real loader, not disk-store persistence.

The parent may now pack from the accepted clean source. MediaWell must subsequently consume the coherent package set, remove its broad peer exception and rerun integration on **Electron 44.7.2**. MediaWell-local repairs remain under their separate review. No action is needed from Dominik.
