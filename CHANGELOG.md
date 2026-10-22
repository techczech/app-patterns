# Changelog

## 0.4.0: @app-patterns/vault-files (2026-10-22)

- Added `@app-patterns/vault-files` 0.4.0: guarded create and in-place rewrite, external-change guard, watch router with own-write suppression by path and hash, cloud conflict copies for any file name, folder availability, the vault marker file and machine names. Extracted from TalkWeaver and WriteFlex; first consumer LearnWeaver (library folder).
- Other packages unchanged at 0.3.0.

## 0.3.0 — 2026-10-20

- Extracted the shared desktop app packages from Bridle into App Patterns Framework.
- Renamed the package scope from `@bridle` to `@app-patterns` and aligned all five packages at 0.3.0.
- Kept package behaviour, the `bridle-settings:` IPC prefix and the settings file and export formats unchanged.
- Adapted the vendored tarball tooling for these packages and removed the agent framework's Windows helper handling.
