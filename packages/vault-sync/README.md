# `@app-patterns/vault-sync`

Automatic backup for a Git-versioned folder of documents. The engine takes snapshots of the files you name, pushes them to a backup branch on the configured remote and checks that the remote holds them. It records how long the oldest edit has gone without a verified backup, so an app can warn when that age passes its limit.

The engine never changes the user's Git state. It does not touch HEAD, the index, staged changes or any file in the worktree, so it can run while people or other tools commit in the same repository.

This package is the core engine only. It has no scheduler, user interface, background helper or sign-in support.

## Use

```ts
import { createBackupEngine } from "@app-patterns/vault-sync";

const engine = createBackupEngine({ machineId: "studio-mac", remote: "origin" });
const scope = { include: ["chapters", "notes/**/*.md"], exclude: ["notes/drafts"] };

// When the editor saves, report the oldest edit that the save wrote to disk.
await engine.noteEdit(vaultPath, oldestFlushedEditTime);

// On the backup cadence (for example once a minute):
const snapshot = await engine.capture(vaultPath, scope);
const pushed = await engine.pushBackup(vaultPath);
if (pushed.state === "pushed" || pushed.state === "up-to-date") await engine.verify(vaultPath);

const { protectionAgeSeconds, lastError, pending } = await engine.status(vaultPath);
```

## Behaviour

- **Snapshots.** `capture` builds a commit with Git plumbing and a private index kept in the checkout's git directory (`<git-dir>/vault-sync/`). It starts from the previous snapshot, applies the added, changed and removed paths in scope, and makes a commit only when the tree changed. The first parent is the previous snapshot. HEAD becomes a second parent when it is not already in the snapshot's history, so the backup chain also carries the user's commits.
- **Scope.** Only paths matching an include pattern and no exclude pattern are captured. A pattern without wildcards names a file or a whole directory; `*` and `?` match within one path segment and `**` spans segments. `.git` and nested repositories are never captured. File bytes are stored as they are on disk; Git filters are not applied.
- **Stable reads.** A file is read only after its last change is at least `settleMs` old (default 250 ms), and the read is accepted only if size, times and inode are unchanged afterwards. A file that does not settle after the bounded retries is left at its previous snapshot version and reported in `pending`. Writers should replace files atomically: a file left truncated for longer than `settleMs` looks like a deliberately emptied file.
- **Backup branches.** Snapshots go to `refs/heads/backup/<machine-id>/<checkout-id>/<yyyy-mm-dd>` (UTC). The checkout id is created once per checkout and kept in the engine folder. Each day's branch starts from the previous day's last snapshot, so the chain is continuous.
- **Push and verify.** `pushBackup` makes a normal push of the newest backup branch. A rejected push is reported as `rejected` and never retried with force. `verify` reads the remote branch with `git ls-remote`; only the pushed object id counts as verified.
- **Deadline record.** `<git-dir>/vault-sync/deadline.json` holds the oldest unprotected edit, the last verified snapshot and the protected-through time. Only a verified snapshot moves the oldest edit forward. Restarts, failed pushes and failed checks leave it as it is. An unreadable record is set aside and replaced by one that treats work as unprotected since its last write.
- **Git processes.** Git runs from argument arrays without a shell, with time and output limits; an abort signal stops the process group. Inherited `GIT_*` variables that could point Git at another repository or index are dropped. Repository hooks, the file-system monitor and automatic maintenance are switched off for the engine's own Git calls. `status` lists the repository's hooks that the engine does not run. Commits are not signed.
- **Concurrency.** Operations on one checkout are serialised inside a process and across processes by a lock file in the engine folder.

## Tests

`bun test` in this folder runs the engine against local bare remotes in temporary folders.
