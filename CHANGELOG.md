# Changelog

## Settings 0.4.2 — 2026-10-25

- Settings: on Windows, a folder fsync refused with EPERM after the settings file has been renamed into place no longer reports the save as failed. Windows opens a folder but refuses to flush it; the file itself is still fsynced before the rename and its identity checked after it. On other systems EPERM from a folder fsync is still an error, and EIO or any other folder fsync failure still reports the save unwritten on every system. Only `@app-patterns/settings` changes; the packed 0.4.1 file stays in `releases/` unchanged.

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
