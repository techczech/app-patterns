---
title: "Astra review of MediaWell command contract repairs round one"
kind: "evidence"
created: "2026-10-23T13:10:00Z"
project: "/Users/dominiklukes/gitrepos/06_apps-utilities/03_misc-utilities/app-patterns"
sources:
  - file: packages/settings-react/src/pages-shortcuts.tsx
---
Attributed review by Astra (gpt-6-astra), 23 October 2026. Reviewed immutable framework range481bcc1..4def24a. Wording retained; line-end whitespace normalised. The library has not yet been packed or accepted.

No action needed. **App Patterns review found one P3 Spec defect: Settings offers a swap that the reserved-chord rules cannot permit.** No actionable Standards findings. Repair that interaction before framework acceptance.

Reviewed repository: `/Users/dominiklukes/gitrepos/06_apps-utilities/03_misc-utilities/app-patterns`.

Exact immutable range:

```text
481bcc1b5f1dde380dc174bbe7bffc90ab8e945b..4def24af480eb22dcab0216c7892f9646d700345
```

All references below identify code at the reviewed head. HEAD, source and index remained unchanged; the checkout remained clean.

**Spec findings**

1. **P3 — Newly rebindable estate commands expose an impossible “Swap” action.**

   The opt-in removes `fixed` from estate holders in [registry.ts:163](/Users/dominiklukes/gitrepos/06_apps-utilities/03_misc-utilities/app-patterns/packages/commands/src/registry.ts:163). They consequently reach the existing conflict interface, which offers Swap unconditionally for a taken chord in [pages-shortcuts.tsx:45–52](/Users/dominiklukes/gitrepos/06_apps-utilities/03_misc-utilities/app-patterns/packages/settings-react/src/pages-shortcuts.tsx:45).

   **Concrete scenario:** Settings retains its default `⌘,`; Refresh holds `⌘R`. In Settings → Shortcuts, record `⌘R` for Settings and select Swap. The UI submits:

   ```json
   [
     {"commandId":"settings","chord":"⌘R"},
     {"commandId":"refresh","chord":"⌘,"}
   ]
   ```

   The store correctly refuses this because Refresh cannot take Settings’ reserved default. The ownership guard is at [registry.ts:255–256](/Users/dominiklukes/gitrepos/06_apps-utilities/03_misc-utilities/app-patterns/packages/commands/src/registry.ts:255).

   **Independent reproduction:** an in-memory React/DOM probe displayed an enabled Swap button and captured that exact operation. Applying it returned `invalid-chord`: “⌘, is kept for ‘Settings…’, so it cannot be used here”. No bindings were changed. Replace succeeded; swapping two custom, unreserved chords succeeded and survived loading.

   **Repair:** validate the complete proposed swap through the shared resolver before offering it. Hide or disable an invalid Swap with the resolver’s explanation, retain valid Replace, and preserve swaps between custom chords. Add a renderer regression connected to the real settings operation. The existing UI code becomes newly reachable for estate defaults through this change.

**Standards findings**

None found in the reviewed scope.

The Electron peer range admits exactly `44.7.2` alongside `>=30 <43`. The compatibility script checks declaration compatibility and verifies the downloaded archive against registry-provided integrity; it does not establish native runtime compatibility. The README describes that boundary appropriately.

**Inspected non-findings**

- All nine estate holders can move or unbind. Their original chords remain reserved, and owners can return to them. Inputs remain intact and returned definitions are frozen. Legacy callers and explicitly fixed non-estate commands retain fixed behaviour.
- Saved overrides, custom-chord swaps, scoped dispatch, collision fallback and explicit overlay exclusions behaved correctly. Across **1,000 synthetic override combinations**, I found no same-scope collisions, reserved-chord theft or prohibited effective bindings.
- Hyper and plain Control+arrow command bindings are refused through registry, settings-adapter, import and CLI paths. Refusal messages identify the platform restriction; Control+Command structural arrows remain accepted.
- Generated menus use App, Edit, View, application menus, Window, Help. Effective accelerators, availability and coverage are retained. Unbound Settings and cheat-sheet commands remain menu-accessible without accelerators.
- Source peer ranges are coherent. Commands, Settings React and Settings Electron use previously unrecorded `0.4.2` versions; Settings remains `0.4.1`. Existing release records and tracked artefacts are unchanged. No vault-files or Updates changes occur in this range.

**Verification and limits**

I independently ran:

```sh
bun test packages/commands \
  packages/settings/src/commands-adapter.test.ts \
  packages/settings/src/node/cli.test.ts \
  packages/settings-electron/src/install.test.ts
```

Using the established temporary-fixture wrapper: **142 passed, 0 failed, 1,007 assertions**, exit 0. I also ran the in-memory probes described above, source peer/version checks and `git diff --check`, which passed.

Sol’s **692-test workspace run, builds/typechecks, official Electron declaration check and temporary-pack comparisons remain builder-reported evidence**. I did not rerun those checks, install dependencies, create packages, launch Electron or access native keychain operations.

MediaWell must still consume the coherent `0.4.x` package set, enable the registry option, remove its blanket peer-check exception and validate its npm installation and Electron runtime. Its original `0.3.0` consumption is **not accepted by this framework review**. MediaWell-local findings 1–3 remain outside this review.

Sol should repair the Swap interaction and return a new pinned revision to the parent reviewer. No action is needed from Dominik.
