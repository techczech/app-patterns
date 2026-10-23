# `@app-patterns/settings-electron`

The Electron host for the shared Settings window (`@app-patterns/settings-react`): the `bridle-settings:` IPC over a `SettingsStore`
(`@app-patterns/settings/node`), the single Settings window, the menu generated from the command registry, export and import
through the native panels, key slots over `safeStorage`, and the preload bridge.

## Main process

```ts
import { installSettings, safeStorageSlots } from "@app-patterns/settings-electron/main";

let host: SettingsHost | undefined;
const store = new SettingsStore({ dir, app: "editorexample", schema, registry: commandsAdapter(registry), appVersion: app.getVersion(),
  onChange: () => host?.storeChanged() });          // invariant 6: outside changes reach the open window
const slots = safeStorageSlots(join(app.getPath("userData"), "keys"), [{ id: "accounts.openai", label: "OpenAI key" }]);
host = installSettings({
  store, schema, registry, menus, slots,
  openMain: () => openMainWindow(),
  sendCommand: (id) => mainWindow()?.webContents.send("command", id),
  window: { preload: join(__dirname, "../preload/settings.cjs"), url: settingsPageUrl },
});
host.openSettingsWindow("accounts");
```

- **`appName`** (optional): the product name for the App menu, the About card and the export file name. Default `app.getName()`, which is the
  package name ("slidewell") when the app runs unpackaged, so pass the product name ("SlideWell").
- **`window.showOnReady`** (optional, default `true`): `false` creates the Settings window hidden and keeps it hidden (also when it is
  opened again), so a hidden end-to-end run can drive it without a window appearing.
- **Window**: one only, 1000×690, not minimizable or full-screen, hidden inset title bar; sandboxed, context-isolated, no Node, no
  webviews, no navigation away from `window.url`, no new windows. An open window is shown, focused and sent the section.
- **Who may call**: only the Settings window's top frame whose URL equals `window.url` exactly (query and fragment included; no other
  route of a shared entry page). A page that changes only its fragment is not navigated away, but loses access until it is back on
  `window.url`, so the Settings page must not change its own fragment. Every argument is checked (types, sizes, keys the schema
  declares, command ids the registry knows, sections) before the store sees it.
- **Pushes** (invariant 6): every view (the `view` answer and each push) is built at once from the store and a slot cache in main, never
  after a wait. Slots are read one at a time: at start, when the window opens or gains focus, after a key is saved or removed, and on
  `slotsChanged()`; a read asked for while one runs is run once when it settles. Each answer updates the cache and pushes. Until the
  first read answers, the cache lists the schema's `secret` settings, each a problem; a read that has not answered within 500 ms
  (`SLOT_READ_MS`) shows every slot as a problem until one does.
- **Menu**: `buildMenuTemplate` from `@app-patterns/commands`, installed at start and rebuilt whenever a shortcut changes. Settings…
  opens the window; Export Settings… runs the save panel; Import Settings… opens the window at General and starts the import there;
  every other command calls `openMain()` then `sendCommand(id)`.
- **Import**: `importApply` takes the file name only and applies the preview main made when the file was picked.
- **Channels**: every channel is named `bridle-settings:<name>` (`CHANNELS`, `CHANNEL_PREFIX`). The prefix is reserved for the shared Settings host: an
  app must not `handle` or `on` any channel under it. If the app already handles or listens on one of them, `installSettings` removes
  the handlers it had registered and throws `@app-patterns/settings-electron: channel "<name>" is already handled by the app; rename the
  app's channel`, so a clash fails at start with the channel named instead of leaving the app without a window.

## Keys

`SecretSlots` is `list()` (id, label, status `connected` | `missing` | `problem`, `detail?`, `last4?`), `set(id, value)`,
`remove(id)`. `SafeStorageSlots` keeps one encrypted file per slot (`<dir>/<id>.key`, 0600, written by rename), takes a `Cipher`
(Electron's `safeStorage` in the app, a fake in tests), and offers `get(id)` for the app's own main-process code. Nothing sent to a
renderer carries a value: slots pass through `slotsForWindow` (known fields only, `last4` cut to four, `detail` only when it is one
of `SLOT_MESSAGES`), and there is no channel that reads a key. No text an app's slots return (a detail, an error, a `check` reason)
reaches the window or a log: a failure is shown in one of `SLOT_MESSAGES`, the saved slot's own `shapeHint`, or the host's own fixed
words.

- **Shape hint**: a `SlotDef` may declare `shapeHint`, a fixed sentence the window shows when the slot's `check` refuses a value
  (`{ id: "accounts.anthropic", label: "Anthropic key", check, shapeHint: "Anthropic keys start with sk-ant-" }`); without one the
  window shows `SLOT_MESSAGES.shape`. The string `check` returns is still never shown, and `check` is called with no `this`. A
  hint is checked when the slots are made (`shapeHintProblem`: not empty, no leading or trailing spaces, at most
  `MAX_SHAPE_HINT_CHARS` = 160 characters, one line, no control or format characters, no `<` or `>`); a bad one throws. Each field
  of a `SlotDef` is read once, into a frozen copy the slots keep, so neither the check nor a getter can change the hint later. A
  shape refusal is the result `{ ok: false, error, refusal: "shape" }` (`SlotResult`); no other result carries the marker.
  `SafeStorageSlots` exposes its hints as `shapeHints`; an app's own `SecretSlots` may offer the same `Map` and set the marker. The
  host copies that map once, at install, and checks the copy (a bad hint throws there). It shows a save error in a hint's words only
  when the result is marked `refusal: "shape"` and the error is exactly the saved slot's own hint. The same words without the
  marker, from another slot, or from a removal become the host's fixed words.

- **Changelog** (invariant 3): every key saved or removed through the window writes one entry through `store.recordSecret` (in
  `@app-patterns/settings`), with who; `from` and `to` are `connected` or `missing`, never the value or any part of it. `from` is the slot cache's status (a problem
  counts as `missing`); the save does not wait for a fresh read.
- **Folder**: the key folder and every folder between it and `root` (`safeStorageSlots` defaults it to the app's userData folder)
  must be real folders, not links, and the key folder must resolve to where it names; a key file is never a link.
- **Writes**: every byte written (a short write is finished; no progress is a failure), fsynced, then renamed over the old file; on
  any failure the temporary file is removed and the old key kept.

## Preload

```ts
import { exposeSettingsBridge } from "@app-patterns/settings-electron/preload";
exposeSettingsBridge(); // window.bridleSettings
```

The bridge is `SettingsActions` from `@app-patterns/settings-react` (pass it as `actions`) plus `view()`, `onChanged(listener)` and
`onSection(listener)`. 

### The preload must be one bundled file

A sandboxed preload (`sandbox: true`, which the Settings window always uses) can `require` only Electron's own modules, not files or
packages. `dist/preload.js` in this package imports a shared chunk, so pointing `window.preload` at it fails silently: the bridge is
never exposed and the page shows no settings. Bundle your preload entry (the file that calls `exposeSettingsBridge`) into one
CommonJS file and point `window.preload` at that:

```sh
bun build src/preload/settings.ts --outfile out/preload/settings.cjs --target node --format cjs --external electron
# or: esbuild src/preload/settings.ts --bundle --platform=node --format=cjs --external:electron --outfile=out/preload/settings.cjs
```

`--external electron` is required; nothing else may stay external.

## Electron compatibility

Version 0.4.2 declares `electron: ">=30 <43 || 44.7.2"` and `^0.4.2` peers for Commands and Settings React. The exact Electron 44.7.2 addition covers MediaWell's tested version without admitting other 43/44 releases or disabling peer checking. Other framework peers retain their existing compatible ranges.

The framework host tests use Electron doubles. The focused compatibility check below downloads the official 44.7.2 package, verifies its declared SHA-512 integrity and typechecks the host's used APIs against its declaration file. It installs no Electron runtime and removes its temporary fixture.

```sh
bun run scripts/check-electron-compatibility.mjs # from the framework root; requires network access
```

## Checks

`bun run check`: builds `@app-patterns/commands`, `@app-patterns/settings` and `@app-patterns/settings-react`, type-checks, runs the tests (fake
Electron, a real store in a temporary folder) and builds.

## Check for Updates

Pass `checkForUpdates: async () => { await checker.checkNow(); }` to `installSettings`. The preload's `checkForUpdates()` calls that callback through a zero-argument channel, restricted to the Settings window's own top frame. The app's checker supplies the Store and busy-mode rules. No feed URL, address or version is accepted from the renderer.
