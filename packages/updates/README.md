# `@app-patterns/updates`

Release-feed validation, version comparison and the state behind quiet update notices. The app tells the user about a new version and links to its download page. It never downloads or installs an update.

## Use

```ts
import { copySource, createUpdateChecker, readUpdateState } from "@app-patterns/updates";
import { createElectronFeedFetcher } from "@app-patterns/updates/electron";
import { net, session } from "electron";

const identity = {
  appName: "Example Editor",
  feedUrl: "https://editor.example/updates.json",
  storeName: "Example Store",
  storeUrl: "https://store.example/editor"
};
const checker = createUpdateChecker({
  identity,
  running: appVersion,
  platform,
  source: copySource({ packaged, store: isStoreCopy(), running: appVersion }),
  fetchFeed: createElectronFeedFetcher(identity, { net, session }),
  readState: () => readUpdateState(loadState(), identity.feedUrl),
  writeState: saveState,
  enabled: () => readSetting("updates.checkForNewVersions") !== false,
  isBusy: () => protectedTaskIsActive(),
  hadConfiguration: () => existingConfiguration,
  hasNotes: version => bundledNotesExist(version),
  now: Date.now,
  changed: snapshot => sendSnapshotToWindows(snapshot)
});
checker.start();
// When the protected task opens or closes:
checker.busyChanged();
// The manual command checks even when daily checking is off:
await checker.checkNow();
// At shutdown:
checker.stop();
```

The host owns persistence and the setting. Keep the check result, skipped version, snooze and seen-notes tracker in app state. Keep `updates.checkForNewVersions` in the app's settings schema, defaulting to `true`, so changes, search and reset use the normal settings machinery.

## Feed

```json
{
  "schema": 1,
  "latest": {
    "version": "1.2.0",
    "released": "2026-10-21",
    "summary": ["One change.", "Another change."],
    "notes": "https://editor.example/whats-new#1.2.0",
    "download": {
      "mac": "https://editor.example/download#mac",
      "windows": "https://editor.example/download#windows"
    }
  }
}
```

Validation rejects the entire feed if any field is invalid. The version must be a public release; previews compare below their own release. The date must exist. Summaries contain one to three text lines, each at most 120 characters; HTML and control characters are refused. Every link must use the feed's own HTTPS origin, without credentials or a port. The response cap is 64 KB. Non-JSON answers, including login pages, fail validation.

The first automatic check waits two minutes. Later checks run daily; a successful check within the last 24 hours postpones the next check. Store and development copies make no feed request. Busy checks wait and retry within 20 seconds, or immediately when `busyChanged()` releases a waiting manual check. A failed automatic check changes only the Settings status.

`skip(version)` hides that exact version. `stopSkipping()` clears it. `notNow()` hides the mark until the next daily check. Manual checks still report skipped versions. `noteLaunch`, `whatsNewMark` and `dismissWhatsNew()` track locally shipped notes after upgrades, including adoption by an existing configuration. First installs and downgrades do not show the mark; clicking it, or seven days of use, retires it.

## Network and host responsibilities

The Electron adapter makes one GET through Electron's system-proxy-aware network stack. It creates a dedicated in-memory partition with caching disabled, omits credentials and cookies, refuses redirects, sends a fixed product-name User-Agent and aborts after ten seconds or 64 KB. It accepts no per-user or version parameter. The host still sees the computer's internet address. Feed URLs with credentials, a query or a fragment are rejected.

The app supplies Store detection, busy detection, state storage, settings and the local notes loader. It also owns commands, platform menus, validated browser links and release checks. Store copies open their store listing and keep local What's new, while suppressing the daily switch and available-version mark. Publish the release and downloads before changing the feed; ship notes for each release and check the live feed against the published version at release time.
