# `@app-patterns/settings`

The pure core of the shared Settings window: one schema per app, the settings
state (which is also the settings file), its changelog, reset and undo, and
moving settings between Macs by export and import.

Everything in the main entry is a pure function over plain data, with no
`node:` import. The file on disk, its lock, the watched store and the agent CLI
are in the `@app-patterns/settings/node` entry (see [The node layer](#the-node-layer-app-patternssettingsnode));
Electron and React (`@app-patterns/settings-electron`, `@app-patterns/settings-react`) call
into both.
Time and ids are injected (`now()`, `newId()`), so every result is
deterministic.

## Rules it keeps

- One schema drives the window rows, search, reset, changelog, CLI and export.
- Every change (window, CLI, import, migration, reset, undo) logs exactly one
  entry per setting changed, with who made it. A value already in place logs
  nothing.
- Secrets (`type: "secret"`) are never stored, set, exported or imported here;
  they live in Keychain behind the Electron layer's key slots. A key saved or
  removed there is logged with `recordSecret`: one entry, with who, whose
  `from` / `to` are `"connected"` or `"missing"`, never the value.
- Whatever an operation writes reads back through `loadState` unchanged.
- A damaged or invalid file never throws: invalid fields fall back to their
  defaults with an `INVALID_SAVED_VALUE` entry, and a file that is not a
  settings file is reported so the node layer can rename it `.damaged`.

## Interface

```ts
const schema = defineSchema({ app, sections, settings }); // throws SchemaError on a programming mistake

// operations: (state, ..., ctx) → { ok: true, state, entries, batch? } | { ok: false, code, error }
set(state, key, value, ctx)
rebind(state, commandId, chord, ctx)          // "" = no shortcut
rebindMany(state, [{ commandId, chord }], ctx) // Swap / Replace, one batch
reset(state, key | { commandId }, ctx)
resetSection(state, sectionId, ctx)
resetShortcuts(state, ctx)                    // every shortcut override removed, one batch; settings untouched
resetAll(state, ctx)
resetEntry(state, entryId, ctx)               // logged as who: { kind: "reset", of, by }
undoBatch(state, batchId, ctx)                // also returns skipped (changed again since)
recordSecret(state, key, from, to, ctx)       // a key saved/removed: status words only; Reset of it is refused

// file
loadState(raw, { schema, appVersion, now, newId, commands?, migrate? })
  // → { state, entries, problem?: "not-settings" | "other-app" | "newer-version", migrated, dropped }
exportFile(state, { appVersion, hostName, now, schema, commands })
previewImport(state, fileTextOrJson, { schema, commands, apply? })
  // → { changes, skipped, alreadyMatch, refused?, source? }
applyImport(state, preview, { file }, { schema, now, newId, commands, by? })

// for the window and the CLI
changedFromDefault(state, schema, section?)   // "N changed from default", Reset section / Reset all counts
historyOf(state, key | { commandId }), lastChange(...)
changeCounts(state), filterChanges(state, { who, text, settings })
batchOf(state, batchId), lastImportBatch(state), newSince(state, seenAt)
searchSettings(schema.settings, schema.sections, query)
valueOf(state, schema, key), chordOf(state, commandId, commands)
checkValue(def, value), parseValue(def, text), formatValue(def, value)
```

`ctx` is `{ schema, who, now, newId, commands }`, with `who` one of
`{ kind: "you" }`, `{ kind: "agent", name }` or `{ kind: "app-update", version }`
(the app applying settings itself because its version changed, such as a
re-migration on update; the loader's own entries use it too).

**Settings an import never applies.** A setting declared `importable: false`
is never changed by an import: the preview lists it in `skipped` with the
reason `NOT_IMPORTABLE` (`"not importable"`), even when the file's value
equals the current one, and `applyImport` refuses a preview that tries to
change it. This holds on every import route (the window's import sheet and the
CLI's `import` both go through `previewImport` and `applyImport`; there is no
other). Nor does import history put an imported value back: when an app marks
a setting `importable: false` after an import already set it, `undoBatch`
skips the setting with the reason `"not importable"` and `resetEntry` refuses
(`not-possible`) unless the value they would write is recorded as `local`
(an `import` origin or an unknown one is refused; the setting's default is
always allowed). The origin is kept on each entry, so it holds after the
import's own entry has left the log. Undoing the import itself, or resetting
the import's own entry, writes the value from before the import, which is the
user's own, and is allowed. Export still writes the setting. An app must set `importable: false`
on every setting that:

- names something to run (a command, an executable);
- names somewhere to send data (a URL or an endpoint);
- names a folder that becomes a code path (a working directory, `PYTHONPATH`).

Such a setting needs no hand-written `canApply` refusal; `canApply` stays for
values that may or may not fit this Mac (a folder that exists here or not).
The agent CLI's `set` still changes such a setting directly (it is the user's
own agent acting on this Mac, logged `who: agent`).

**Commands.** This package does not depend on `@app-patterns/commands`. The host
passes a required `CommandsAdapter`, shaped like the registry's
`resolveBindings`; `commandsAdapter(registry)` builds one from any
`defineRegistry` registry, wording each refused shortcut the way the registry's
`rebindMessage` does (“⌘D is already used by “Pin or unpin””):

```ts
{
  isCommand(commandId): boolean;
  defaultChord(commandId): string;                 // "" = none
  resolve(overrides): { bindings, rejected: { commandId, chord, reason }[] };
}
```

Every keys map the core produces (load, rebind, reset, reset section and all,
undo, import preview and apply) is judged as a whole set by `resolve`, never
chord by chord, so a swap survives a reload and a reset cannot leave two
commands on one chord. An id that is not a command, or that is a setting's key,
never enters the shortcut map: it is dropped on load and import, refused by
`rebind`, and left out of an export. An import preview lists only the
shortcuts the whole set accepts, so applying the preview of an unchanged state
always succeeds. When a set is refused (on load, import or undo), what is kept
is a maximal subset, deterministic by input order (not necessarily the
largest): while the set is refused, the last change in input order that the
resolution names is removed; then each removed change is tried again, in input
order, and kept if the set stays clean.

**Undo.** `undoBatch` puts back what the batch changed, except a setting or
shortcut that any later entry touched (whatever its value now) and a shortcut
whose earlier chord no longer fits the set; those are listed in `skipped`.

## File formats

**Settings file, format v2.** Only values that differ from the default are
stored; the changelog is newest first and capped at 300 entries, and the cap
never splits a batch. An operation that would log more than 300 entries in one
batch (a reset of more than 300 settings, an import of more than 300) is
refused with code `too-many` and changes nothing. The loader drops a saved
batch larger than 300 whole, counting every saved entry that carries its id
before any is dropped as malformed or about a secret, and logs one entry with
`key: "changes"` (reserved), `from` = the number of entries dropped,
`to: null` and `note: "INVALID_SAVED_VALUE"`. When one load resets more than 20
values of one kind, it logs one summary entry for that kind instead of one per
value, in the same shape with `from` = the count and `note:
"INVALID_SAVED_SETTINGS"` or `"INVALID_SAVED_SHORTCUTS"`. A summary lists in
`targets` the setting keys or command ids it reset (sorted; on load, anything
that is not a non-secret setting or a command is dropped), and undo counts
each target as changed by it. The loader's own
entries are never pushed out by the cap; the oldest saved history goes first. It rebuilds every entry from its known fields
(unknown properties are dropped at every level) and drops any entry about a
`secret` setting except one as `recordSecret` writes it (status words, who you,
an agent or an app update, no batch, no note).

```json
{
  "format": "bridle-settings",
  "version": 2,
  "app": "editorexample",
  "settings": { "editor.proseSize": 18 },
  "keys": { "go-to-heading": "⇧⌘O" },
  "changes": [
    { "id": "c2", "at": 1760866320000, "key": "editor.proseSize", "from": 16, "to": 18, "who": { "kind": "you" },
      "fromOrigin": "local", "toOrigin": "local" },
    { "id": "c1", "at": 1760780000000, "commandId": "go-to-heading", "from": "⇧⌘G", "to": "⇧⌘O",
      "who": { "kind": "agent", "name": "Claude Code" }, "fromOrigin": "local", "toOrigin": "local" }
  ]
}
```

`who` is one of `{ kind: "you" }`, `{ kind: "agent", name }`,
`{ kind: "app-update", version }`, `{ kind: "import", file, exportedFrom?,
exportedAt?, appVersion?, skipped?, by? }` or `{ kind: "reset", of, by? }`.
Entries written by one operation that changed more than one thing, and every
import, share a `batch` id. `fromOrigin` and `toOrigin` say where each of the
entry's values came from: `"import"` (an import file) or `"local"` (typed
here by you or an agent, a migration, or a default; a default is always
local). An import writes `toOrigin: "import"`; every other change writes
`"local"`; `fromOrigin` is the origin of the value replaced, taken from the
newest entry about the setting when its `to` is still the value held, and left
out (unknown) otherwise. Undo and Reset of an entry write the value they put
back with the origin recorded for it. The loader's repair entries and a key's
status entries carry no origin; an entry from a file written before origins
were recorded has none, and its origin is unknown.

**Export file, format v1.** Settings changed from default and shortcut
overrides; never keys.

```json
{
  "format": "bridle-settings-export",
  "version": 1,
  "app": "editorexample",
  "appVersion": "0.31.0",
  "exportedFrom": "Example Mac",
  "exportedAt": "2026-10-17T18:04:00.000Z",
  "settings": { "editor.proseSize": 18 },
  "keys": { "go-to-heading": "⇧⌘O" }
}
```

Import refuses a file that cannot be parsed, is not an export, is from another
app, or is from a newer export version. It skips (with a reason) settings the
app does not know, keys, settings declared `importable: false`, invalid values,
and values `canApply` rejects on this Mac, and counts the settings that already
match.

## Example

```ts
import { applyImport, defineSchema, emptyState, previewImport, set, undoBatch } from "@app-patterns/settings";

const schema = defineSchema({
  app: "editorexample",
  sections: [{ id: "editor", label: "Editor", icon: "pen-line" }],
  settings: [
    { key: "editor.proseSize", label: "Prose size", section: "editor", type: "number", default: 16, min: 10, max: 32, unit: "pt" },
  ],
});
let n = 0;
const commands = registryAdapter; // the host adapts its @app-patterns/commands registry
const ctx = { schema, commands, who: { kind: "you" } as const, now: Date.now, newId: () => `c${++n}` };

let state = emptyState(schema.app);
const r = set(state, "editor.proseSize", 18, ctx);
if (r.ok) state = r.state; // r.entries[0]: 16 → 18, who you

const preview = previewImport(state, fileText, { schema, commands });
if (!preview.refused) {
  const done = applyImport(state, preview, { file: "Example Editor Settings 2026-10-17.json" }, ctx);
  if (done.ok) state = done.state;                    // one batch, who: import
  // later: undoBatch(state, done.batch!, ctx) puts every value back
}
```

## The node layer (`@app-patterns/settings/node`)

```ts
import { commandsAdapter } from "@app-patterns/settings";
import { SettingsStore, runSettingsCli } from "@app-patterns/settings/node";

const store = new SettingsStore({
  dir: app.getPath("userData"), app: "editorexample", schema, registry: commandsAdapter(registry),
  appVersion: app.getVersion(), migrate, onChange: (state) => win.webContents.send("settings:changed", state),
});
await store.ready;
await store.set("editor.proseSize", 18);          // → { ok, state, entries, batch? } | { ok: false, code, error }
```

**The file** is `<dir>/settings.json` (format v2 above), written pretty-printed
and 0600. `SettingsFile` (ported from Agent Traffic Control's `OwnedJsonFile`)
does the disk work:

- Every change is: take the lock → read the file again → run the pure
  operation on what is on disk → write → release. The in-memory view is never
  written, so a stale view cannot overwrite a newer file, and the app and the
  CLI writing at once lose nothing.
- The write goes to a temporary file `.settings.json.<pid>.<hex>.tmp`
  created with O_EXCL, mode 0600 and no symlink follow, in the same folder; it
  is fsynced, renamed over the file, and the folder is fsynced. A platform that
  cannot fsync a folder (EISDIR, EPERM or EACCES on opening it, EINVAL,
  ENOTSUP) is not an error; any other failure (EIO) fails the write with code
  `unwritten`, because the change may not survive a power cut.
- Temporary files left by a writer that died mid-write are removed: when the
  store opens (if the lock is free at once) and before every write, under the
  lock, any `.settings.json.<pid>.<hex>.tmp` whose process is dead or that is
  older than 60 s goes.
- The lock is `<file>.lock`, holding `{ pid, at, nonce, host }`. It is taken by
  writing that metadata to a private temporary file and hard-linking it to
  `<file>.lock` (`link()` is atomic and fails when the lock exists), so the
  lock never exists without its metadata. A lock is stale when its process is
  dead (same host, `process.kill(pid, 0)`), or when it is older than the 30 s
  lease whoever holds it (no update holds the lock that long, so a crashed
  writer's pid reused by another process cannot block writes for ever). A lock
  that does not parse is judged by the lease alone. A stale lock is broken by
  renaming it to a private name and reading it there. If it is not the lock
  judged stale (another waiter broke it and someone took a fresh one), the
  breaker has lost the race: it deletes that copy too and never puts a lock
  back, because by then another writer may have taken the free lock,
  committed and released, and a restored lock would let its first owner
  commit a stale read. The fresh lock's owner finds it has lost the lock and
  runs its update again: a lost race costs a retry, never a change. Release
  first checks the lock is still its own, so it does not remove someone
  else's.
- The holder checks it still holds the lock (the lock file is the very file
  it linked, same device and inode, and holds its nonce) immediately before
  every destructive step: setting a damaged file aside, and the rename that
  commits a write. A holder that lost it (evicted after the lease, or its lock
  moved by a breaker) touches nothing more and runs the whole update again,
  within the same 5 s wait. A wait longer than 5 s gives up with code
  `locked`. Not covered: a lock lost between that check and the rename itself.
  The file system must support hard links (APFS, HFS+, ext4 do).
- A file that does not parse, is larger than 1 MB, is JSON `null` or a top
  level that is not an object, or is JSON but not a settings file (and not a
  legacy file `migrate` understands) is renamed
  `settings.json.damaged-<timestamp>` (never over an earlier one; made 0600,
  since it may hold a secret; only the 3 newest are kept), the defaults load,
  a line goes to `log`, and one changelog entry records it:
  `{ key: "changes", from: null, to: null, note: "INVALID_SAVED_VALUE", who: { kind: "app-update", version } }`.
  Setting it aside happens under the lock, after the lock and the folder are
  checked again. If the update then loses the lock before it writes, the
  retry still writes the defaults and the entry (a file still missing then is
  the one this update set aside). If the damaged file cannot be set aside,
  nothing is written over it and nothing uses it: `store.problem()` is
  `{ code: "unarchived" }`, every change is refused (code `refused`), every
  CLI command fails with exit 1 and prints no value, and the file is left as
  it is until it can be set aside.
- Values the loader repaired, a migrated legacy file (always, even when the
  migration yields only defaults), and a lossy load are written back at once
  (so no secret stays on disk). A load is lossy (`LoadResult.lossy`) when the
  file is not, structurally, what writing the loaded state would produce: the
  loader dropped or changed some part of it (an entry, a value, a whole field,
  an unknown field, an unknown property of a kept entry, a value equal to its
  default). It is decided by comparing the whole parsed file with the loaded
  state, not by looking for secrets: a key pasted under an unknown name cannot
  be recognised, and whatever was dropped would go at the next write anyway.
- **Checks before each change to the folder.** Three checks: *containment*
  (the folder is not a link and resolves to `root`, default `dir`, and
  `settings.json`, if there, is a regular file); *folder* (the folder is not
  a link, resolves to the root, and has the device and inode it had when the
  lock was taken); *lock* (the lock is still this process's). Before each call
  that changes the folder, its check is the last thing awaited, and names
  are chosen and files inspected before it:
  - creating the folder at the start of an update: containment only (it may
    not exist yet); the store's watcher creates it only when nothing is there;
  - the lock's own files (its metadata file, the link, moving a lock aside,
    unlinking those): folder only, so a `settings.json` that became a link
    never keeps the lock alive;
  - sweeping temporary files, setting a damaged file aside, pruning old
    `.damaged-` files, creating the temporary file, and the commit rename:
    all three;
  - making a set-aside file 0600: on its open descriptor, only when it is the
    very file moved and the folder check holds;
  - removing this write's own uncommitted temporary file: folder only (also
    after the lock was lost; the file is this process's).

  After each rename the folder and the moved file's device and inode are
  checked again; a mismatch refuses the update (code `refused`) and touches
  nothing more. A file or folder that fails containment is neither read nor
  written (code `refused`). Another app's file, or one from a newer version,
  is left as it is and changes are refused; `store.problem()` says why.
- **Threat model and accepted residuals.** The checks guard against a folder
  or file that is a link, or was swapped, before an operation (a
  misconfigured or stale link). Node has no `openat`/`renameat`, so a
  path-based call can land elsewhere if the folder is swapped between its
  check and the call. Only a process running as the same user can do that,
  and it could already write these files directly, so this race is not
  closed. Accepted: a swap between a check and its call (under a swap loop,
  lock metadata files and a moved lock have been seen landing in the other
  folder); a swap during a rename itself (detected afterwards, not undone);
  a `.damaged-` file created by someone else between the name check and the
  rename that sets a damaged file aside is overwritten; a lock lost between
  the lock check and the commit rename. When a check refuses, files the lock
  or a write left are not removed through a folder that is not the one
  locked; the sweep removes every `.settings.json.<pid>.<hex>.tmp` (lock
  metadata and moved locks included) once its process is dead or it is
  older than 60 s.
- **Differences from the spec, for the record.** The spec says a lock is
  stale after 10 s if its process is dead. Here a dead process's lock is
  stale at once, and a live process's lock after the 30 s lease. The spec
  says the damaged file is renamed `.damaged`; it is named
  `settings.json.damaged-<ISO time>`, for example
  `settings.json.damaged-2026-10-19T12-00-00-000Z`.
- If a write would pass 1 MB, the oldest history is dropped (never a batch,
  never this change's entries) until it fits.

**The store** mirrors the pure operations, each async and each through the
lock: `set`, `rebind`, `rebindMany`, `reset`, `resetSection`, `resetShortcuts`, `resetAll`,
`resetEntry`, `undoBatch`, `applyImport(preview, { file })`; plus `view()`,
`previewImport(fileText)`, `exportFile({ hostName })`, `reload()`,
`refuseWrites(reason?)` (quitting), `flushWithin(ms)`, `close()`. Changes are
logged as `who` (default you; the CLI passes the agent; an app re-applying
settings because its version changed opens a store with
`who: { kind: "app-update", version }`). Failure codes are the operation's
(`unknown-key`, `invalid-value`, `secret`, `not-possible` for an operation that
cannot be done, such as an undo whose every setting changed again since ...),
`rejected` (the app's `beforeWrite` rule), or the file's (`locked`, `refused`,
`unwritten`, `closed`, `too-large`).

**A rule over the whole write (`beforeWrite`).** A schema `validate` sees one
value. For a rule between settings (two folders that must not overlap), pass
`beforeWrite` when creating the store, and the same function to
`runSettingsCli`, so the CLI keeps the rule:

```ts
const store = new SettingsStore({ ..., beforeWrite: (p) =>
  overlaps(p.next.settings) ? { reject: "That folder overlaps your own archive" } : undefined });
```

It runs once per write, under the lock, after the operation and before
anything reaches the disk, for every route: `set`, `rebind`, `reset`,
`reset-section`, `reset-shortcuts`, `reset-all`, `reset-entry`, `undo`,
`import`, `record-secret` and `migration` (the loader reading a legacy file).
It is given a `WriteProposal`: `route`, `who` (the store's actor;
`app-update` for a migration), `before` (the state on disk; the defaults for a
missing, damaged or legacy file), `next` (the whole state the write would
leave), `entries` (the changelog entries it adds), and the `keys` and
`commandIds` it changes. Return nothing to let the write go, or
`{ reject: reason }` to refuse it: nothing is written and the caller gets
`{ ok: false, code: "rejected", error: reason }` (the CLI exits 2). It must be
synchronous; a throw, a promise or any other return refuses the write and logs
a line (it fails closed). It cannot change the write: it gets frozen copies,
and the store writes its own state, which is checked against the schema and
the registry again after the rule, whatever the rule said. It sees no secret
(the state never holds one). A write that changes nothing calls it not at all.

A refusal ends the write. Nothing of it reaches the disk, there is no second
try by another route, and the rule is asked at most once for that operation.
If the file turned out to be a legacy file, the migration that would have gone
with the refused change is not written either; it is judged on its own at the
next read (reload, launch, or the watcher).

**Repairs are not judged, by design.** The loader's pure repairs (route
`repair`, never passed to the rule): an invalid saved value put back to its
default, a damaged file set aside, and a lossy load written back without what
the loader left out (a secret, or anything else it does not read). They only
remove values or put them back to the default, so they cannot bring in
anything a rule could object to, and a veto could leave a secret or a damaged
file on disk. They are written even when the rule refuses the change that
found them. One consequence: a file written by a newer version of the app
(same file format) loses the settings, shortcuts and fields this version does
not know as soon as this version opens it or sees it change, not only at its
first write, as it already did then.

**A migration is never a repair.** Every migration write is judged as route
`migration` (who: the app update), even one that yields only defaults or no
changelog entries. While the rule refuses it: the legacy file stays on disk
as it is; nothing migrated is shown (the view is the defaults with no history,
the state of a file of this version that holds no settings);
`store.problem()` is `{ code: "rejected", error: reason }`, and one line is
logged per reason. Changes may still be made: each carries the migration and
is judged with it, so it too is refused while the migrated values offend the
rule. The CLI runs every command on the defaults with the same line on stderr
and, with `--json`, `problem` in its output; a read exits 0.

**Watching.** The store watches the folder (not the file, so a file replaced by
rename is seen too). 100 ms after the last event, and never more than 500 ms
after the first, it reads the file again and calls `onChange` when the state
differs, so an open Settings window shows an outside change within a second.
Its own writes do not call `onChange` twice. On opening, the watcher is
installed before the first read, and one more read follows 100 ms later, so a
change made while the store opens is not missed.

## The agent CLI

`runSettingsCli(argv, opts, io)` returns the exit code and never throws. Each
app ships its own bin wrapper:

```ts
#!/usr/bin/env bun
process.exit(await runSettingsCli(process.argv.slice(2),
  { app: "editorexample", appName: "Example Editor", dir, schema, registry: commandsAdapter(registry), version },
  { stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t) }));
```

`io` also takes `env`, `now`, `newId`, `cwd` and `hostName` for tests.

| Command | Does |
|---|---|
| `list [--section <id>]` | every setting with its value; a secret shows as kept in Keychain |
| `get <key>` | the value (plain text: the raw value) |
| `set <key> <value>` | changes one setting; toggles take on/off, choices their value or label |
| `reset <key>` · `reset --section <id>` · `reset --all --yes` | back to default; `--all` without `--yes` prints the count and exits 3 |
| `changes [--limit <n>]` | the newest entries (default 20) |
| `export <file>` | writes an export file; never over an existing file |
| `import <file> [--yes]` | without `--yes` prints the preview and exits 3; with it, imports as one batch |
| `undo-import --last \| <batch>` | undoes an import batch |
| `rebind <command> <shortcut>` | sets your shortcut for a command: `cmd+shift+l`, `⌘⇧L`, or `none` for no shortcut |
| `reset-shortcut <command>` · `reset-shortcut --all --yes` | removes your shortcut for a command (or every one); `--all` without `--yes` prints the count and exits 3 |

Every command takes `--json` and `--agent <name>` (else `BRIDLE_AGENT`, else
`"agent"`; at most 200 characters, no control characters). Every change is
logged `who: { kind: "agent", name }`; an import is
`who: { kind: "import", file, by: { kind: "agent", name } }`.
`rebind` and `reset-shortcut` write the same shortcut map the Settings window
writes, through the same store, lock and whole-set check: a reserved chord, one
another command holds, or a fixed command is refused (exit 2) and nothing is
written. A store `beforeWrite` rule passed to `runSettingsCli` applies to every
CLI write.

Exit codes: **0** done · **1** the settings file cannot be used or could not
be saved (the file or folder is a link, another app's, from a newer version, a
damaged file that could not be set aside, or the disk refused); on a file it
may not use, every command fails this way, reads included, and prints no value
· **2** bad input or not possible (unknown command, key or section, an invalid
value, a secret, a refused import file, an undo whose every setting changed
again since) · **3** needs confirmation · **4** the settings file stayed locked
for 5 s ("The settings file is busy: another app or agent is changing it. Try
again in a moment").

Options are parsed, and `--` ends them: `set readAloud.skipPrefix -- --json`
stores the text `--json` and prints plain text. In plain text output every
string that came from a file (values, keys, names, an import file's source
fields and skip reasons) has its control characters written as `\uXXXX`, so a
settings or import file cannot send escape sequences to the terminal; `--json`
output is escaped by JSON itself.

No secret value is printed or written. `set` on a `secret` setting is refused
(exit 2): "“Speech service key” is a key. Keys are kept in Keychain, never in
the settings file: set it in Example Editor › Settings › Accounts and keys."

**`--json` shapes** (one object on stdout, also for errors; errors are not
repeated on stderr, which carries only the store's log lines):

```jsonc
// list
{ "settings": [{ "key", "label", "section", "type", "value", "default", "changed" }
              /* a secret: */ , { "key", "label", "section", "type": "secret", "value": null, "default": null, "changed": false, "secret": true }] }
// get: one row as in list, plus "lastChange": ChangeEntry when there is one
// set, reset <key>
{ "ok": true, "changed": true, "entries": [ChangeEntry] }        // "changed": false, "entries": [] when it already had the value
// reset --section, reset --all --yes: as set, plus "batch" when more than one changed
// reset --all without --yes (exit 3)
{ "ok": false, "exit": 3, "error": "This puts 3 settings …", "needsConfirmation": true, "count": 3 }
// changes
{ "changes": [ChangeEntry], "total": 42 }
// export
{ "ok": true, "file": "/abs/path.json", "settings": 2, "keys": 1 }
// import without --yes (exit 3)
{ "ok": false, "exit": 3, "needsConfirmation": true, "preview": ImportPreview }
// import with nothing to change (exit 0)
{ "ok": true, "applied": false, "preview": ImportPreview }
// import --yes
{ "ok": true, "applied": true, "batch": "…", "entries": [ChangeEntry], "skipped": [SkippedItem] }
// undo-import
{ "ok": true, "batch": "…", "entries": [ChangeEntry], "skipped": [SkippedItem] }
// rebind, reset-shortcut <command>: as set; reset-shortcut --all: as reset --all
// any error
{ "ok": false, "exit": 2, "error": "…", "code"?: "invalid-value" | "secret" | "not-possible" | "locked" | "refused" | …, "refused"?: Refused }
// a file the CLI may not use (exit 1)
{ "ok": false, "exit": 1, "error": "…", "code": "refused", "problem": "refused" | "other-app" | "newer-version" }
```

Run `bun run check` in this package (typecheck, tests, build).
