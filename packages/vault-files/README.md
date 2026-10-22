# @app-patterns/vault-files

File safety for desktop apps whose content is a folder of files (a "vault") that other programs also write: a cloud sync client, a text editor, an agent, the same app on another computer. Node and Bun; `node:fs` only. Electron-specific actions (moving a file to the Trash) are passed in.

Extracted from TalkWeaver (`talk-writer.ts`, `outline-disk-guard.ts`, `vault-file.ts`, `conflict-copies.mjs`, `vault-availability.ts`, `vault-machines.ts`, `path-containment.ts`) and WriteFlex (`guarded-document-write.ts`, `workspace-watcher.ts`). Those apps adopt it when they are next worked on.

## Modules

- `guarded-write`: `createFile` makes a new file and refuses a name that is taken; `rewriteFile` rewrites an existing file in place only while it still holds the bytes it was read as (`expect`, a sha256). No part of a path may be a link; the vault root is never created; a rewrite that fails halfway keeps a temp file with the full text. `readFileGuarded` reads through one no-follow handle.
- `disk-guard`: the external-change guard for open files: baseline per file, `changed` / `removed` / `partial`, `accept` after the person chose.
- `watch-router`: the watcher's rule apart from the native watch: ignored paths, 220 ms bursts, and own-write suppression by path and the hash written. `createFolderWatcher` runs a recursive `fs.watch`.
- `conflict-copies`: OneDrive, Dropbox and Google Drive copy names and Git markers for any canonical file name; the scanner moves byte-identical copies to the Trash through an injected `trashItem` and reports the rest.
- `availability`: is the folder there (not signed in, moved, no permission, not found, not responding), never blocking.
- `vault-file`: the marker file `.<app>/<name>.json`: size cap, schema ownership, unknown keys kept, no absolute paths, id pattern.
- `machines`: machine names seen per vault, kept in app data.

## Test

```sh
bun test
```

Tests run over temp folders and clean up after themselves.
