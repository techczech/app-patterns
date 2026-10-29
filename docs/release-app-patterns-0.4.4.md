---
title: App Patterns Framework 0.4.4
status: released
created: 2026-10-29
---

# App Patterns Framework 0.4.4

This release brings together the reviewed main branch changes since the published framework 0.4.1. Framework 0.4.4 names the release collection; its seven packages keep independent versions.

## Changes since the published release

- Command contracts and shortcut conflict handling include the repairs recorded on main. The command README now documents text-entry ownership and native menu keyboard safety.
- Settings 0.4.2 handles Windows directory fsync EPERM after a completed save; other directory fsync errors still report failure.
- Settings Electron accepts the exact Electron 44.9.1 peer release alongside its existing supported range.
- The repository includes a project page for GitHub Pages and clearer vendored installation instructions.

No production implementation changes were made during this preparation. Commands 0.4.3 includes the newer README. Settings React 0.4.3 and Settings Electron 0.4.4 carry refreshed workspace development dependency metadata. These changes require new archive versions under the existing immutability policy. Compiled files match their preceding archived versions.

## Package inventory

| Package | Version | Release asset |
| --- | --- | --- |
| @app-patterns/commands | 0.4.3 | `app-patterns-commands-0.4.3.tgz` |
| @app-patterns/outline | 0.4.1 | `app-patterns-outline-0.4.1.tgz` |
| @app-patterns/settings | 0.4.2 | `app-patterns-settings-0.4.2.tgz` |
| @app-patterns/settings-electron | 0.4.4 | `app-patterns-settings-electron-0.4.4.tgz` |
| @app-patterns/settings-react | 0.4.3 | `app-patterns-settings-react-0.4.3.tgz` |
| @app-patterns/updates | 0.4.1 | `app-patterns-updates-0.4.1.tgz` |
| @app-patterns/updates-react | 0.4.1 | `app-patterns-updates-react-0.4.1.tgz` |

The release contains these seven archives, `manifest.json`, `SHA256SUMS` and `LICENSE`. GitHub also provides the tagged source archives.

The manifest records SHA-512 integrity and content digests. SHA256SUMS records archive, manifest and licence byte hashes. Both update archives declare MIT but lack the licence text; distribute the root LICENSE alongside them and retain it when vendoring. This preparation does not alter their immutable 0.4.1 archives.

## Installation

Use the tagged checkout with Bun 1.3.10. Download the seven archives and manifest from this release into `releases/`, verify them against SHA256SUMS, then follow the [vendoring instructions](https://github.com/techczech/app-patterns/blob/v0.4.4/README.md#install-with-vendored-tarballs). There is no npm publication. Package `private: true` flags intentionally prevent it.

After vendoring, copy the matching root `LICENSE` to your app’s `vendor/app-patterns/LICENSE`, commit it with the archives and retain the notice in the distributed app. The vendor tool does not copy the licence notice.
