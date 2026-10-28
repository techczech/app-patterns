---
title: "Shared keyboard safety pattern and applicability 2026-10-28"
kind: "evidence"
created: "2026-10-28T02:40:15Z"
project: "/Users/dominiklukes/gitrepos/06_apps-utilities/03_misc-utilities/app-patterns"
sources:
  - file: packages/commands/README.md
  - file: packages/commands/src/key-dispatch.ts
  - file: packages/commands/src/menu-template.ts
---
Keyboard safety pattern added to packages/commands/README.md and linked from the root README. Codex gpt-6.1-sol, 28 October 2026.

Baseline 56d642e, clean, git pull --ff-only: Already up to date (exit 0). Documentation only; no shared implementation, dependency, package version, tarball or API change.

The pattern explains renderer ownership and native-menu safety separately. It covers effective editable state, custom/shadow editor integration, defaultPrevented/IME, exact modifiers and AltGr, native editing, control/scope ownership, Shift-only/bare keys, effective bindings and menu/palette/cheat-sheet parity. It explicitly states that commands 0.4.2 requires caller guards and that registerAccelerator:false does not protect macOS native key equivalents. ReportScout's local wrapper is the reference, not a new shared export.

Verification: bun test packages/commands/src/key-dispatch.test.ts packages/commands/src/chords.test.ts packages/commands/src/menu-template.test.ts: exit 0, 32 tests, 235 assertions. git diff --check: exit 0. These are existing pure helper tests, not DOM or native AppKit coverage. ReportScout source and installed 0.3.2 hidden tests both exit 0; exact hashes, event-path checks and native limitations are filed in its research/2026-10-28-reportscout-keyboard-safety-verification-2026-10-28.md. No independent review owed because no API, seam, security or write-path contract changed.

Source inspection: packages/commands/src/key-dispatch.ts, chords.ts, menu-template.ts; ReportScout src/menu-keys.mjs, src/renderer/report-scout.tsx and its existing root-cause evidence. The canonical keyboard skill was read; no skill edits or publication were needed. Full fleet migration remains outside scope.
