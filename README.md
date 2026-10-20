# App Patterns Framework

Shared patterns for desktop apps, written in TypeScript. One command registry drives the command palette, menus and keyboard shortcuts. A shared Settings window provides schema-driven controls, a changelog, undo, export and import, and a headless CLI for agents. Markdown outline commands support section selection and movement in CodeMirror.

## Packages

- [`@app-patterns/commands`](packages/commands/README.md) defines the command registry, key chords, dispatch and menu templates.
- [`@app-patterns/settings`](packages/settings/README.md) provides the settings schema, history, undo, transfer, file store and agent CLI.
- [`@app-patterns/settings-react`](packages/settings-react/README.md) renders the Settings window from props and supplies its stylesheet.
- [`@app-patterns/settings-electron`](packages/settings-electron/README.md) connects the settings store, window, menus, preload bridge and encrypted key slots in Electron.
- `@app-patterns/outline` provides Markdown outline ranges and CodeMirror commands.

All packages are version 0.3.0. The React components require React and lucide-react; the Electron host requires Electron. See each package manifest for supported peer versions.

## Install with vendored tarballs

Use Bun 1.3.10, recorded in `.bun-version`. From a committed checkout of this repository:

```sh
bun install --frozen-lockfile
bun run check
bun run release:pack
```

In your app, declare the packages you need in `package.json`, for example `"@app-patterns/settings-react": "^0.3.0"`. Commit that declaration before vendoring. From this repository, preview and then apply the dependency changes:

```sh
bun run release:vendor /path/to/your-app
bun run release:vendor /path/to/your-app --write
```

The tool copies the required tarballs into the app's `vendor/app-patterns/`, adds sibling peers and root overrides, and replaces dependency ranges with relative `file:` tarball paths. It leaves peer ranges intact. It refuses dirty app manifests or vendor files. It never runs an install or changes Git state in the app.

In the app, run `bun install` and `bun install --frozen-lockfile`, then run its checks. Commit `package.json`, `bun.lock` and `vendor/app-patterns/` together. When migrating from live folder dependencies, remove the old `node_modules` and lockfile before reinstalling.

Each released version is immutable. Change the package version before packing changed contents. Commit `releases/manifest.json` in this repository; generated tarballs are ignored. See [the vendored tarball decision](docs/adr/0001-apps-consume-versioned-vendored-tarballs.md).

## Build and test

```sh
bun install --frozen-lockfile
bun run build
bun run check
```

`check` builds dependencies first, then runs each package's typecheck, tests and build in dependency order, followed by the release tooling tests. Tests run headlessly with DOM and Electron test doubles. They do not launch an app or use the keychain. `bun run test` runs the package and tooling tests without rebuilding.

## Origin and compatibility

Extracted from Bridle on 20 October 2026 at commit `f295550`. These packages contain shared app patterns and have no dependency on its agent framework. The scope changed from `@bridle/*` to `@app-patterns/*`; package behaviour is unchanged. The `bridle-settings:` IPC prefix and `bridle-settings` / `bridle-settings-export` data formats remain for compatibility with existing consumers. The `window.bridleSettings` preload bridge and the `BRIDLE_AGENT` environment variable keep their names for the same reason.

Licensed under the [MIT licence](LICENSE).
