---
layout: default
title: App Patterns Framework
---

# Shared patterns for desktop apps

App Patterns is a set of TypeScript packages for command discovery, settings, update notices and Markdown outline editing. Use the pieces your app needs. React supplies the settings and update interfaces; Electron adapters connect them to the desktop host.

[Read the source and installation guide](https://github.com/techczech/app-patterns#install-with-vendored-tarballs) · [Download a published release](https://github.com/techczech/app-patterns/releases) · [Read the changelog](https://github.com/techczech/app-patterns/blob/main/CHANGELOG.md)

## Choose a package

| Package | What it provides |
| --- | --- |
| [commands](https://github.com/techczech/app-patterns/blob/main/packages/commands/README.md) | A command registry, key chords, dispatch and menu templates. |
| [settings](https://github.com/techczech/app-patterns/blob/main/packages/settings/README.md) | A schema, history, undo, import/export, file storage and agent CLI. |
| [settings-react](https://github.com/techczech/app-patterns/blob/main/packages/settings-react/README.md) | A Settings window driven by props, with its stylesheet. |
| [settings-electron](https://github.com/techczech/app-patterns/blob/main/packages/settings-electron/README.md) | Settings windows, menus, a preload bridge and encrypted key slots. |
| [updates](https://github.com/techczech/app-patterns/blob/main/packages/updates/README.md) | Feed validation, version comparison, daily checking, skip and snooze state. |
| [updates-react](https://github.com/techczech/app-patterns/blob/main/packages/updates-react/README.md) | Update status marks, a release popover and an About and updates card. |
| [outline](https://github.com/techczech/app-patterns/tree/main/packages/outline) | Markdown outline ranges and CodeMirror section commands. |

## Install from a release

Packages ship as versioned tarballs in GitHub releases. They are not published to npm. Vendor the required archives into your app and commit them with its manifest and lockfile. The repository's vendor tool previews the changes before applying them and checks compatible sibling packages.

1. Get the source checkout for the release you choose and use Bun 1.3.10.
2. Download that release's tarballs and manifest into `releases/` in the checkout.
3. Declare the packages your app needs and commit its dependency declaration.
4. Run `bun run release:vendor /path/to/your-app` from the checkout to preview the changes.
5. Apply with `--write`, then copy the matching release’s root `LICENSE` to your app’s `vendor/app-patterns/LICENSE` and commit it with the archives. Retain this MIT notice in the distributed app’s licence notices; the vendor tool does not copy it.
6. Install in your app and run its checks.

The [full installation guide](https://github.com/techczech/app-patterns#install-with-vendored-tarballs) explains dependency declarations, lockfiles and migration from live folders. Each package README describes its API and integration requirements.

## Integrate with your app

The app supplies its commands, settings schema and host behaviour. Update notices use the app's feed URL, product name and storage. Check each package manifest for supported peer versions. Keyboard integrations must handle text-entry ownership and native menu accelerators; the [keyboard safety guide](https://github.com/techczech/app-patterns/blob/main/packages/commands/README.md#keyboard-safety-and-text-entry) describes those responsibilities.

## Licence and origin

App Patterns is [MIT licensed](https://github.com/techczech/app-patterns/blob/main/LICENSE). It was extracted from Bridle in October 2026. Existing settings data formats and bridge names remain compatible with its consumers.
