# `@app-patterns/vault-sync`

Automatic backup for a Git-versioned folder of documents. The engine takes snapshots of the files you name, pushes them to a backup branch on the configured remote and checks that the remote holds them. It records how long the oldest edit has gone without a verified backup, so an app can warn when that age passes its limit.

The engine never changes the user's Git state. It does not touch HEAD, the index, staged changes or any file in the worktree, so it can run while people or other tools commit in the same repository.

This package is the core engine only. It has no scheduler, user interface, background helper or sign-in support.

## Use

```ts
import { createBackupEngine } from "@app-patterns/vault-sync";

const engine = createBackupEngine({ machineId: "studio-mac", remote: "origin", trustedCredentialHelpers: ["osxkeychain"] });
const scope = { include: ["chapters", "notes/**/*.md"], exclude: ["notes/drafts"] };

// When the user edits a document, report the edit for that document and keep its ticket.
// It counts as unprotected until that document's save is acknowledged and backed up.
const ticket = await engine.noteEdit(vaultPath, editTime, { path: "notes/chapter-1.md" });

// When the editor saves in place: announce the write first, acknowledge it once the bytes are durable,
// naming the document and the newest ticket the saved bytes contain.
const writeToken = await engine.noteWriteStart(vaultPath, ["notes/chapter-1.md"]);
// ... write and fsync ...
await engine.noteFlush(vaultPath, {
  upTo: newestTicketInThisSave,
  paths: ["notes/chapter-1.md"],
  completedWrites: [{ path: "notes/chapter-1.md", token: writeToken }],
});

// On the backup cadence (for example once a minute):
const snapshot = await engine.capture(vaultPath, scope);
const pushed = await engine.pushBackup(vaultPath);
if (pushed.state === "pushed" || pushed.state === "up-to-date") await engine.verify(vaultPath);

const { protectionAgeSeconds, lastError, pending } = await engine.status(vaultPath);
```

## Behaviour

- **Snapshots.** `capture` builds a commit with Git plumbing and a private index kept in the checkout's git directory (`<git-dir>/vault-sync/`). It starts from the previous snapshot, applies the added, changed and removed paths in scope, and makes a commit when the tree changed or an initial empty scoped snapshot is needed to carry exact absence proof. A genuinely empty scope with no such proof creates no snapshot; later unchanged captures reuse the existing snapshot. The only parent is the previous snapshot. The user's commits are never parents, so a push publishes only content that was in scope when it was captured, never the repository's history.
- **Existing backup history.** Before a chain is extended or pushed, every commit in it must be a snapshot this engine made for this machine and checkout, descending from a root commit the engine recorded when it made it (`<git-dir>/vault-sync/chain.json`). A chain from an older version (whose snapshots had the user's HEAD as a parent) or anything else under the backup branch stops backup with the block reason `unsupported-history`. Nothing is rewritten or deleted.
- **Coverage record.** Each snapshot's commit message carries `snapshot-format: 2`, `coverage-through: <ms>` (every edit made before that time was on disk and is in the snapshot, except in the pending files and unlisted folders), `pending-files: <n>` and `unlisted-folders: <n>`. `listBackups` reports these as `protectedThrough`, `pendingFiles` (files and folders together; 0 only for a complete capture) and `unlistedFolders`, with `coverage: "unknown"` for a tip without them. The commit time is reported separately as `snapshotTime` and is not a coverage claim.
- **Scope.** Only paths matching an include pattern and no exclude pattern are captured. A pattern without wildcards names a file or a whole directory; `*` and `?` match within one path segment and `**` spans segments. `.git` and nested repositories are never captured. File bytes are stored as they are on disk; Git filters are not applied.
- **Stable reads.** A file is read only after its last change is at least `settleMs` old (default 250 ms), and the read is accepted only if size, times and inode are unchanged afterwards. A file that does not settle after the bounded retries is left at its previous snapshot version and reported in `pending`. A file in a folder that exists but cannot be read is also left pending, never recorded as deleted, and the folder itself is reported as pending (`unlisted`), because files that were never captured may be in it. A path is recorded as deleted only after a direct check finds it gone, including an acknowledged path that disappeared before its first snapshot. Its absence must be in scope, accessible without symlinked ancestors and free of coordinated writes during the check. An unchanged snapshot can cover that absence after verification.
- **Capture recovery.** A request makes at most three complete passes under the same operation lock, waiting 100 ms between passes only when a file was left `writing` or `unstable`. Fresh record generations and all existing safety checks apply to each pass. A monotonic two-second budget, measured from the first pass, limits retry read work and waits; checks run between filesystem operations and during settling waits. An in-flight filesystem or Git call must return before a budget check can run. A pass admitted to commit finishes its existing ref/record writes without a budget interruption. The first pass always completes normally. Earlier safe partial snapshots remain in the same chain. The returned snapshot, `startedAt`, changes and pending paths describe the last completed pass; `startedAt` is that pass's start, and `committed` reports whether that pass made a commit. Capture and retry do not resolve protection age; the corresponding snapshot still needs push and exact remote verification.
- **Writer contract.** Stable reads reject a write that is visibly in progress, but they cannot prove a write is complete: a writer that pauses mid-write for longer than `settleMs` leaves bytes that look settled. A writer is supported when it either replaces files atomically (writes a temporary file, then renames it over the target) or calls `noteWriteStart(paths)` before writing in place and `noteFlush` after the bytes are durable, supplying the returned token for each completed path in `completedWrites`. Only an exact path/token match ends an active interval; old receipts and acknowledgements without tokens leave it active, including all-document acknowledgements. Replaying a completed receipt is safe. Starts that overlap an active path are refused, so writers must serialise their intervals on that path. Atomic replacements need no write token. Between those calls the engine keeps the paths at their previous snapshot version, and so does any capture that was reading while such a write started or finished. Other writers that change files in place are not supported.
- **Backup branches.** Snapshots go to `refs/heads/backup/<machine-id>/<checkout-id>/<yyyy-mm-dd>` (UTC). The checkout id is created once per checkout and kept in the engine folder. Each day's branch starts from the previous day's last snapshot, so the chain is continuous.
- **Backup remote.** The remote must have exactly one address, used for both pushing and fetching, and that address must be HTTPS, a `file://` address or an absolute local path. SSH addresses, remote helpers and remotes that set `receivepack`, `uploadpack`, `vcs` or `mirror` are refused with the block reason `unsupported-remote`. Push, verification, the secret scan and restore all use this one remote.
- **Push and verify.** Before every push the engine scans every blob reachable from the snapshot it sends: the whole chain, each time, because the remote can drop anything it held between any listing and the push. A chain whose blobs together exceed `maxScanTotalBytes` is held back (`too-large-to-scan`), so the scan's cost grows with the chain. `pushBackup` then makes a normal push of the newest backup branch. A rejected push is reported as `rejected` and never retried with force. `verify` reads the remote branch with `git ls-remote`; only the pushed object id counts as verified.
- **Network transport.** Each push, verification and restore fetch checks the remote once at its start and then uses that address, not the remote's name, in a private Git directory the engine creates for the operation and removes afterwards. No repository, user or system Git configuration applies there, so a change to the remote during a scan, an address rewrite (`url.*.insteadOf`), a protocol grant or a TLS setting such as `http.sslVerify=false` in the repository has no effect. HTTPS trust and credentials come only from the application: its environment (for example `GIT_SSL_CAINFO` for a private certificate authority), its `gitEnv` and its `trustedCredentialHelpers`.
- **Deadline record.** `<git-dir>/vault-sync/deadline.json` holds every edit not yet in a verified snapshot, the last verified snapshot and the protected-through time. Order comes from the record's own generation counter, never from clock readings; times only measure age. An edit reported with `noteEdit` stays unprotected until a `noteFlush` naming its path (or all documents) and a ticket at least its own acknowledges its save, a capture that read the record after the acknowledgement reads the saved file or confirms it deleted, and that snapshot is verified. An edit reported without a path is covered only by an acknowledgement with `allDocuments: true` followed by a complete capture. Changes the engine finds on disk without a report are protected once the capture that read them is verified; a file or folder it cannot read counts as unprotected from the capture before. Restarts, failed pushes, failed checks and elapsed time never resolve an edit. A record of an older schema, or a damaged one, is set aside and replaced by one that keeps its oldest known edit time (or the file's last write, if earlier) as one unsaved edit of unknown documents, which only an all-documents acknowledgement and a later verified complete capture clear.
- **Git processes.** Git runs from argument arrays without a shell, with time and output limits; an abort signal stops the process group. Inherited `GIT_*` variables that could point Git at another repository or index are dropped. Repository hooks, the file-system monitor, automatic maintenance and signature checks are switched off for the engine's own Git calls, and replacement refs and grafts are ignored. Only the file and HTTPS transports are allowed (`GIT_ALLOW_PROTOCOL`, which no configuration can widen), the far-side programs are fixed (`--receive-pack`, `--upload-pack`), and the repository's credential helpers and askpass program are cleared; the only credential helpers that run are those passed as `trustedCredentialHelpers`. `status` lists the repository's hooks that the engine does not run. Commits are not signed.
- **Concurrency.** Operations on one checkout are serialised inside a process and across processes by a lock in the engine folder. A lock left by a process that has exited is reclaimed by removing only that process's own lock file, so two processes recovering at once cannot both take it. Edit and save reports use a separate short lock and do not wait for a capture, push or verification.

## Tests

`bun test` in this folder runs the engine against local bare remotes in temporary folders.
