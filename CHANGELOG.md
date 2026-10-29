# Changelog

## @app-patterns/vault-files 0.4.2 — 2026-10-22

- Added shared guarded create and in-place rewrite, external-change checks, file watching, cloud conflict-copy handling, folder availability and vault marker files, extracted from TalkWeaver and WriteFlex.
- Refuse overwriting rename fallbacks and multiply linked rewrites. Check directory and inode identity around writes, preserve recovery bytes after detected swaps, and document the remaining pathname race intervals.
- Preserve the original 0.4.0 package and record the checked 0.4.2 package separately. Version 0.4.2 distinguishes this reviewed build from parallel local 0.4.1 candidates.

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
