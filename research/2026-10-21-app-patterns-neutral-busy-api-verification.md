---
title: "App Patterns neutral busy API verification"
kind: "evidence"
created: "2026-10-21T00:27:01Z"
project: "/Users/dominiklukes/gitrepos/06_apps-utilities/03_misc-utilities/app-patterns.worktrees/updates"
sources:
  - url: "https://github.com/techczech/app-patterns/tree/feat/updates"
---
The public NoteEvent union and noteReducer now use busy for the answer field and busy-change event, without a compatibility alias. The guarded browser links README heading is now "Guarded browser links (host example)". Both updates packages were searched; no other app-specific wording or consumers of the old names remained.

Verification on 2026-10-21 by GPT-6.1 Sol in T3 Code:
- The two new reducer regression tests first failed against the old API, then passed after the rename. They cover holding an answer while busy, releasing it when idle, clearing a visible note when busy starts and showing idle answers immediately.
- grep -rniE "talk|present|slide|vault|talkweaver" packages/updates packages/updates-react --exclude-dir=dist returned no output (exit 1, no matches).
- bun test packages scripts: 676 pass, 0 fail, 6778 expect() calls, 39 files.
- bun run typecheck: exit 0, all seven packages built and typechecked.
- gitleaks dir --redact --no-banner: no leaks found, about 1.81 MB scanned before this evidence record.
- The repository's prior privacy verification pattern was run across both updates packages, excluding dist. It found only two existing tests with synthetic credential-bearing .example URLs that must be rejected. No private paths, institutional names or private addresses were found. Diff review confirmed no new requests, telemetry or identifiers.
- git diff --check: passed.

No PR was opened and nothing was published.
