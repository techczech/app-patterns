# `@app-patterns/updates-react`

Controlled React components for update notices. They accept a snapshot from `@app-patterns/updates` and injected actions. They perform no IPC and contain no network or filesystem access.

```tsx
import { UpdatesProvider, UpdateMarks, AboutUpdatesCard } from "@app-patterns/updates-react";
import "@app-patterns/updates-react/updates.css";

<UpdatesProvider snapshot={snapshot} actions={actions}>
  <footer>{version}<UpdateMarks /></footer>
  <AboutUpdatesCard />
</UpdatesProvider>
```

`UpdateStatusMark` renders the available-version mark and its Download, Not now and Skip this version popover. `WhatsNewMark` renders the separate Updated mark; `UpdateMarks` renders both. Busy snapshots suppress both marks. Store and development copies suppress the available-version mark. `AboutUpdatesCard` shows the running version, copy source, local notes, daily switch, manual-check answer and privacy statement. Store copies replace the daily controls with the injected store's explanation and link.

The `UpdateActions` interface provides `check`, `setEnabled`, `download`, `notNow`, `skip`, `stopSkipping`, `openNotes`, `openStore`, `dismissWhatsNew`, `loadNotes` and `showNotes`. The host binds `createUpdateLinkOpener` from `@app-patterns/updates/electron` in main and passes only link kinds and optional versions to it, never renderer-supplied addresses. `loadNotes(version)` reads only notes shipped with the app, and `showNotes(version, items)` opens the app's own notes surface. Nothing opens automatically. Keep the snapshot prop current when main broadcasts state changes.

The stylesheet uses `--app-updates-*` variables with defaults. It ships separately for status bars outside the Settings window; `@app-patterns/settings-react/settings.css` and `SETTINGS_CSS` include it for the Settings card.

## Settings window

The existing Updates slot accepts the same snapshot and actions:

```tsx
import { SettingsUpdatesCard } from "@app-patterns/settings-react/updates";
<SettingsWindow {...settingsProps} updateCard={<SettingsUpdatesCard snapshot={snapshot} actions={actions} />} />
```

The earlier `update={{ text, detail, tone }}` status slot remains supported. In Electron, pass `checkForUpdates` to `installSettings`; `window.bridleSettings.checkForUpdates()` invokes that callback through the host's guarded Settings channel. The host supplies all other update actions through its app bridge.
