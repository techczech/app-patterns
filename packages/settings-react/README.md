# `@app-patterns/settings-react`

The shared Settings window for desktop apps.
React components driven only by props: no IPC, no Electron, no file access.
The host (`@app-patterns/settings-electron`) wires `actions` to the settings store.

```tsx
import { SettingsWindow, SETTINGS_CSS } from "@app-patterns/settings-react";
import "@app-patterns/settings-react/settings.css"; // or inject SETTINGS_CSS as a <style>

<SettingsWindow
  schema={schema}            // defineSchema(...) from @app-patterns/settings
  state={state}              // the current SettingsState
  registry={registry}        // defineRegistry(...) from @app-patterns/commands
  appInfo={{ name: "Example Editor", version: "0.31.4", build: "2810", icon: "pen-line" }}
  actions={actions}          // the host implements these (below)
  slots={slots}              // Accounts and keys: { id, label, status, detail?, last4? }[]
/>
```

The window fills its parent (`height: 100%`). It draws the body only: the title bar and
the native save and open panels belong to the host.

## What the host passes

- **`actions`**: `set`, `rebind`, `rebindMany`, `reset`, `resetSection`, `resetAll`, `resetEntry`,
  `undoBatch`, `exportSettings`, `importPick`, `importApply`, `setSecret`, `removeSecret`. Each may
  be sync or async and returns `{ ok: true }` or `{ ok: false, error }` (the core's `OpResult` fits as it is);
  a failure shows as a notice at the top of the pane. Optional: `signOut`, `choosePath`, `checkForUpdates`.
  `importPick` opens the native panel and returns `{ fileName, preview }` where `preview` is `previewImport`'s result;
  `importApply(preview, fileName)` is `applyImport`. When it succeeds the window opens Changes with the new import selected:
  return the batch id (`{ ok: true, batch }`, which an `OpResult` already carries) or update `state` right after, and the
  window picks the newest import that was not there before.
- **`slots`**: `id` is the key of the `secret` setting it belongs to. The window never receives a key's value
  and never keeps one: a key typed into the form goes to `setSecret` once and the field is cleared.
- **`rowHints`** (by setting key), for what the schema does not say: `control: "segmented"`, `summary` (the short
  line under the label; the schema's `help` is the long text in the inspector), `disabled` (the reason),
  `missing` (a folder not on this Mac), `step`, `example` (the plain value in the agent command: `sentence`, not `"sentence"`).
- **`changesSeenAt` / `onChangesSeen`**: entries newer than `changesSeenAt` are new (the badge on Changes, the
  agent highlight on a row). `onChangesSeen(now)` is called when Changes opens (also when the window starts on it), and again when the user
  leaves Changes or the window unmounts while on it. The window keeps the "new" highlight for the rest of the current visit
  itself, whatever `changesSeenAt` becomes in the meantime.
- Also optional: `customPages`, `menus` (the app's `MenuDecl`s, so the Shortcuts inspector can say where a
  command sits), `commandHelp`, `showCommand`, `update`, `appNames`, `agentCommandsForShortcuts`, `onCopy`, `now`,
  `initial` (opens the window in any view state; the demo uses it; it cannot carry a key).
- **`agentCommandsForShortcuts`** is off by default. Turned on, a shortcut's inspector shows
  `<cli> settings rebind <command> <chord>` and `<cli> settings reset-shortcut <command>`. **These two CLI verbs do not exist yet**
  (pending in `@app-patterns/settings`'s CLI); leave the prop off until they do.

## Copied commands

Every dynamic part of a copied command (setting key, value, slot id, batch id, command id, file name) goes through one
encoder, `shellArg`: plain words as they are, anything else in POSIX single quotes (`'` written as `'\''`). A file in
Downloads is written `~/Downloads/'the file.json'` so the shell still expands the `~`. Undo import names its batch;
`--last` only when that batch is the newest import.

## Keys

The key field in Accounts and keys starts empty and is uncontrolled. Nothing can prefill it, the window keeps no copy, and the
field is cleared as soon as the key is handed to `setSecret`, whether the save then succeeds or fails.

## Keyboard

Every selectable row (settings, Changes entries, import headers, shortcuts including the fixed ones, slots) takes focus; focusing
it or any control in it selects it, and Enter or Space on the row selects it. A number field steps with the arrow keys; its step
buttons are out of the tab order. A sheet puts focus on its safe control (Cancel for a confirm), keeps Tab inside, closes on
Escape and gives focus back to the control that opened it; the rest of the window is `inert` while it is open.

Counts, history, filters, search and the import preview all come from `@app-patterns/settings`'s queries
(`changedFromDefault`, `historyOf`, `changeCounts`, `filterChanges`, `newSince`, `batchOf`, `searchSettings`,
`formatValue`, `previewImport`); the components only lay them out.

## Styling

`settings.css` (also `SETTINGS_CSS`, generated from it by `bun run gen:css`) is a light identity in the system
font. Every class starts with `bsw-`. An app sets its accent with `--bsw-accent` (and the tint variables beside it)
on `.bsw-root` or any ancestor (`.my-app { --bsw-accent: #7a3fd1; }` works: the stylesheet declares no accent variable itself and each use carries the default as a `var()` fallback). Long values in the inspector, such as file paths, wrap inside it and show in full as a tooltip; the inspector never scrolls sideways.

## Demo

`bun run demo` serves http://localhost:5177/ (add `#7` for frame 7): the window on Example Editor-like data from the
mockup, a working host that runs the real core operations, and a switcher for all sixteen frames (keys 1–9, 0, Q W E R T Y,
arrows). Frames 11 and 13 draw the
macOS app menu and save panel, which the host draws natively; the rest is this package. In frame 8 the key field is empty when the frame opens (nothing can prefill it).

## Checks

`bun run check`: regenerates the CSS string, type-checks, runs the tests and builds (`dist` is plain `tsc` output,
with the production JSX runtime). `build` first builds `@app-patterns/commands` and `@app-patterns/settings`.

## Update notices

The base entry point requires no updates packages. For the rich About card, install the optional updates peers and opt in:

```tsx
import { SettingsWindow } from "@app-patterns/settings-react";
import { SettingsUpdatesCard } from "@app-patterns/settings-react/updates";
<SettingsWindow {...settingsProps} updateCard={<SettingsUpdatesCard snapshot={snapshot} actions={actions} />} />
```

The stylesheet includes the card styles. The legacy `update={{ text, detail, tone }}` prop remains supported. Its button appears only when `appInfo.canCheckForUpdates` is true and a checker action exists; errors appear in the Settings notice. The Electron host declares this capability automatically.
