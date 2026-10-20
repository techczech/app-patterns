# Changelog

## 0.3.0 — 2026-10-20

- Extracted the shared desktop app packages from Bridle into App Patterns Framework.
- Renamed the package scope from `@bridle` to `@app-patterns` and aligned all five packages at 0.3.0.
- Kept package behaviour, the `bridle-settings:` IPC prefix and the settings file and export formats unchanged.
- Adapted the vendored tarball tooling for these packages and removed the agent framework's Windows helper handling.
