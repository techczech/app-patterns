# Changelog

## 0.4.1 — 2026-10-21

- Re-issued 0.4.0 as 0.4.1 with all seven packages kept aligned. The packed 0.4.0 files in `releases/` predate the review fixes below and were never published; they stay in place unchanged.
- Update notices: guards added and Settings integration made optional.
- Updates: the public API uses a neutral busy state.
- Updates: comments and wording made neutral.
- Settings: the lock test creates its impostor copy while the original exists, so it is reliable on Linux.

## 0.3.0 — 2026-10-20

- Extracted the shared desktop app packages from Bridle into App Patterns Framework.
- Renamed the package scope from `@bridle` to `@app-patterns` and aligned all five packages at 0.3.0.
- Kept package behaviour, the `bridle-settings:` IPC prefix and the settings file and export formats unchanged.
- Adapted the vendored tarball tooling for these packages and removed the agent framework's Windows helper handling.
