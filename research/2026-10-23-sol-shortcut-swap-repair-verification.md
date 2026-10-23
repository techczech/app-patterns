---
title: "Sol shortcut swap repair verification"
kind: "evidence"
created: "2026-10-23T13:15:36Z"
project: "/Users/dominiklukes/gitrepos/06_apps-utilities/03_misc-utilities/app-patterns"
sources:
  - file: packages/settings-react/src/shortcut-conflicts.test.tsx
  - file: _TASK-LOG/task-mediawell-shortcut-swap-repair.md
artefact: "research/2026-10-23-sol-shortcut-swap-repair-check.log"
---
App Patterns shortcut swap repair by Sol, 23 October 2026, based on unchanged source HEAD 0f2406b6cdb3791c5dad5433aa64db84c8e51149 plus the uncommitted Settings React repair.

The corrected renderer regression failed before production edits (4 passed, 4 failed, 37 assertions) and passed after the fix (8 passed, 0 failed, 66 assertions). The renderer previews complete Swap and Replace batches through the real pure Settings operation and shared resolver; invalid actions are disabled with their reason. Custom swaps, reload, changed effective bindings, preview immutability and final operation authority are exercised.

Bun 1.3.10: renderer typecheck passed. Full isolated `bun run check`: 700 passed, 0 failed, 7,047 assertions; all workspace builds/typechecks and release-tool tests passed. Ten React act warnings occurred in existing Settings window tests. Full raw output is attached; SHA-256 9a1d030212c1a38eb46b7a5a117681e4944ef3437885260579beb03d2931f452.

Exact commands, package set and scope limits are recorded in `_TASK-LOG/task-mediawell-shortcut-swap-repair.md`. No package/version/lock/release record change; no pack, commit, push or app launch. Independent review and clean-source packing remain with the parent.
