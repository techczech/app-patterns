# Changelog

## Framework 0.4.4 — 2026-10-29

- Ships the keyboard safety and text-entry integration documentation added after commands 0.4.2 was packed. Compiled command files are unchanged. The version advances because README contents are part of the immutable archive.
- The framework release assembles the settings 0.4.2, settings-react 0.4.3 and settings-electron 0.4.4 with outline, updates and updates-react 0.4.1. Package versions remain independent.
- Settings React and Settings Electron advance patch versions because Bun resolves workspace development dependencies into their packed metadata. Their compiled files are unchanged. Existing archives remain immutable.
- Adds a GitHub Pages project page and release/install guidance.


## Settings Electron 0.4.3 — 2026-10-28

- Settings Electron: the Electron peer range adds the exact release 44.9.1 (`>=30 <43 || 44.7.2 || 44.9.1`), the 44.x release that fixes GHSA-jr5w-w6x2-84p9. The host's code is unchanged; the opt-in compatibility check now verifies the official declaration files of both 44.7.2 and 44.9.1. The packed 0.4.2 file stays in `releases/` unchanged.

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
