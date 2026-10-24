/**
 * Restore API: list backup branches on the remote, list snapshots, read a path at a snapshot and write
 * it back into the worktree as an ordinary uncommitted file change.
 *
 * Invariants:
 * - Backup branches are fetched into a private namespace (refs/vault-sync/backups/<remote>/...); the
 *   user's remote-tracking refs, HEAD, index and branches are never written.
 * - Restore writes exactly one file in the worktree (temp file + rename in the same directory). It never
 *   writes through a symlinked component, outside the worktree or into .git.
 * - A target that exists is not replaced unless `overwrite` is set; by default the restored bytes go to a
 *   sibling named "<name> (restored YYYY-MM-DD HHMM).<ext>".
 * - The cloud-folder and network-mount rules apply. Restore does not need the checkout to be enabled.
 */
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open as openHandle, readFile, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { validateId } from "./backup-ref.ts";
import { BackupRefusedError, type BackupBlock } from "./blocks.ts";
import { splitNul, type GitRunner } from "./git-process.ts";

export interface BackupEntry {
  /** Branch name without the refs/heads/ prefix: backup/<machine>/<checkout>/<yyyy-mm-dd>. */
  branch: string;
  machine: string;
  checkout: string;
  /** UTC date in the branch name. */
  date: string;
  /** Object id of the newest snapshot on the branch. */
  tip: string;
  /** Commit time of the tip in milliseconds: everything up to here is on the remote. */
  protectedThrough: number;
}

export interface SnapshotInfo {
  id: string;
  /** Commit time in milliseconds. */
  time: number;
}

export interface ListSnapshotsOptions {
  /** Most snapshots to return. Default 500. */
  limit?: number;
}

export interface RestoreOptions {
  /** Worktree-relative path to write to. Default: the same path as the backup's. */
  targetPath?: string;
  /** Replace an existing target that differs from the backup. */
  overwrite?: boolean;
}

export type RestoreRefusal = "target-exists" | "unsafe-path" | "beyond-symlink" | "not-in-snapshot" | "unsupported-entry" | "bad-snapshot" | "too-large";

export class RestoreRefusedError extends Error {
  readonly reason: RestoreRefusal;
  constructor(reason: RestoreRefusal, message: string) {
    super(message);
    this.name = "RestoreRefusedError";
    this.reason = reason;
  }
}

export interface RestoreResult {
  /** "restored": bytes written. "unchanged": the target already holds exactly these bytes. */
  state: "restored" | "unchanged";
  /** Worktree-relative path written (or already identical). */
  path: string;
  /** True when the target existed and the bytes went to a sibling name. */
  sibling: boolean;
  bytes: number;
}

export interface RestoreApi {
  /** Fetches backup branches and returns one entry per branch, from any number of machines and checkouts. */
  listBackups(repo: string, options?: RestoreOperation): Promise<BackupEntry[]>;
  /** Snapshots on a fetched backup branch, newest first; with `path`, only those that changed it. */
  listSnapshots(repo: string, branch: string, path?: string, options?: ListSnapshotsOptions & RestoreOperation): Promise<SnapshotInfo[]>;
  readAtSnapshot(repo: string, snapshot: string, path: string, options?: RestoreOperation): Promise<Buffer>;
  restoreFile(repo: string, snapshot: string, path: string, options?: RestoreOptions & RestoreOperation): Promise<RestoreResult>;
}

export interface RestoreOperation {
  signal?: AbortSignal;
}

export interface RestoreDeps {
  remote: string;
  now: () => number;
  authorEmail: string;
  maxFileBytes: number;
  localTimeoutMs: number;
  networkTimeoutMs: number;
  maxOutputBytes: number;
  realRoot(repo: string): Promise<string>;
  locationBlock(real: string): Promise<BackupBlock | null>;
  runner(): GitRunner;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function privateRoot(remote: string): string {
  return `refs/vault-sync/backups/${remote}/`;
}

export function parseBackupBranch(name: string): { machine: string; checkout: string; date: string } | null {
  const parts = name.split("/");
  if (parts.length !== 4 || parts[0] !== "backup") return null;
  try {
    return { machine: validateId("machine id", parts[1]!), checkout: validateId("checkout id", parts[2]!), date: DAY.test(parts[3]!) ? parts[3]! : (() => { throw new Error("date"); })() };
  } catch {
    return null;
  }
}

/** A worktree-relative path with no empty, "." or ".." parts, no NUL, no backslash and nothing under .git. */
function cleanRelative(path: string): string[] {
  if (typeof path !== "string" || path === "" || path.includes("\0") || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    throw new RestoreRefusedError("unsafe-path", "the path must be relative to the folder");
  }
  const parts = path.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..") || parts.some((p) => p.toLowerCase() === ".git")) {
    throw new RestoreRefusedError("unsafe-path", "the path must stay inside the folder and outside .git");
  }
  return parts;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function siblingName(path: string, ms: number): string {
  const d = new Date(ms);
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
  const dir = dirname(path);
  const ext = extname(path);
  const stem = basename(path, ext);
  const name = `${stem} (restored ${stamp})${ext}`;
  return dir === "." ? name : `${dir}/${name}`;
}

export function createRestoreApi(deps: RestoreDeps): RestoreApi {
  const run = (cwd: string, timeoutMs: number, signal?: AbortSignal) => ({ cwd, timeoutMs, maxOutputBytes: deps.maxOutputBytes, signal });

  /** Resolves the worktree, applies the location rules, returns a runner bound to it. */
  async function openRepo(repo: string) {
    const real = await deps.realRoot(repo);
    const where = await deps.locationBlock(real);
    if (where) throw new BackupRefusedError(where);
    return { real, git: deps.runner() };
  }

  function privateRef(branch: string): string {
    const name = branch.startsWith("refs/heads/") ? branch.slice("refs/heads/".length) : branch;
    if (!parseBackupBranch(name)) throw new RestoreRefusedError("bad-snapshot", "not a backup branch name");
    return `${privateRoot(deps.remote)}${name}`;
  }

  async function fetchBackups(real: string, git: GitRunner, signal?: AbortSignal): Promise<void> {
    const dst = `${privateRoot(deps.remote)}backup/*`;
    await git.ok(["fetch", "--quiet", "--prune", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--no-auto-gc", deps.remote, `+refs/heads/backup/*:${dst}`], run(real, deps.networkTimeoutMs, signal));
  }

  async function checkedSnapshot(real: string, git: GitRunner, snapshot: string, signal?: AbortSignal): Promise<string> {
    if (typeof snapshot !== "string" || !OID.test(snapshot)) throw new RestoreRefusedError("bad-snapshot", "a snapshot is a full commit id");
    const type = await git.run(["cat-file", "-t", snapshot], run(real, deps.localTimeoutMs, signal));
    if (type.code !== 0 || type.stdout.toString("utf8").trim() !== "commit") throw new RestoreRefusedError("bad-snapshot", "that snapshot is not in this repository; list the backups first");
    return snapshot;
  }

  /** Mode and blob id of a path at a snapshot, or null. Literal path match, NUL-terminated. */
  async function entryAt(real: string, git: GitRunner, snapshot: string, parts: string[], signal?: AbortSignal): Promise<{ mode: string; oid: string; size: number } | null> {
    const out = await git.ok(["ls-tree", "-z", "-l", snapshot, "--", `:(literal)${parts.join("/")}`], run(real, deps.localTimeoutMs, signal));
    const record = splitNul(out)[0];
    if (!record) return null;
    const tab = record.indexOf("\t");
    const [mode, type, oid, size] = record.slice(0, tab).split(/\s+/);
    if (type !== "blob" || !mode || !oid) {
      throw new RestoreRefusedError("unsupported-entry", "that path is a folder or a submodule at this snapshot");
    }
    return { mode, oid, size: Number(size) };
  }

  async function readBlob(real: string, git: GitRunner, snapshot: string, path: string, signal?: AbortSignal) {
    const parts = cleanRelative(path);
    await checkedSnapshot(real, git, snapshot, signal);
    const entry = await entryAt(real, git, snapshot, parts, signal);
    if (!entry) throw new RestoreRefusedError("not-in-snapshot", "that file is not in this snapshot");
    if (entry.mode === "120000") throw new RestoreRefusedError("unsupported-entry", "a symbolic link is not restored");
    if (entry.size > deps.maxFileBytes) throw new RestoreRefusedError("too-large", "that file is larger than the restore limit");
    const bytes = await git.ok(["cat-file", "blob", entry.oid], { ...run(real, deps.localTimeoutMs, signal), maxOutputBytes: Math.max(deps.maxOutputBytes, entry.size + 1024) });
    return { bytes, executable: entry.mode === "100755", parts };
  }

  /** Walks the target's directories, creating missing ones, refusing any symlink or non-directory. */
  async function ensureDirs(root: string, parts: string[]): Promise<string> {
    let current = root;
    for (const part of parts.slice(0, -1)) {
      current = join(current, part);
      let info;
      try {
        info = await lstat(current);
      } catch {
        await mkdir(current);
        info = await lstat(current);
      }
      if (info.isSymbolicLink()) throw new RestoreRefusedError("beyond-symlink", "a folder on the way to the target is a symbolic link");
      if (!info.isDirectory()) throw new RestoreRefusedError("unsafe-path", "a file is in the way of the target folder");
    }
    if ((await realpath(current)) !== (parts.length > 1 ? join(root, ...parts.slice(0, -1)) : root)) {
      throw new RestoreRefusedError("beyond-symlink", "the target folder is not inside the folder");
    }
    return current;
  }

  async function existing(file: string): Promise<{ kind: "none" } | { kind: "file"; bytes: Buffer }> {
    let info;
    try {
      info = await lstat(file);
    } catch {
      return { kind: "none" };
    }
    if (info.isSymbolicLink()) throw new RestoreRefusedError("beyond-symlink", "the target is a symbolic link");
    if (!info.isFile()) throw new RestoreRefusedError("unsafe-path", "the target is not a regular file");
    if (info.size > deps.maxFileBytes) throw new RestoreRefusedError("too-large", "the existing target is larger than the restore limit");
    return { kind: "file", bytes: await readFile(file) };
  }

  async function writeAtomic(dir: string, name: string, bytes: Buffer, executable: boolean): Promise<void> {
    const temp = join(dir, `.${name}.restore-${randomBytes(6).toString("hex")}.tmp`);
    const handle = await openFile(temp, executable ? 0o755 : 0o644);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await rm(temp, { force: true });
      throw error;
    }
    await handle.close();
    try {
      await rename(temp, join(dir, name));
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  return {
    async listBackups(repo, options = {}) {
      const { real, git } = await openRepo(repo);
      await fetchBackups(real, git, options.signal);
      const root = privateRoot(deps.remote);
      const out = await git.ok(["for-each-ref", "--format=%(refname)%00%(objectname)%00%(committerdate:unix)%00", root], run(real, deps.localTimeoutMs, options.signal));
      const fields = out.toString("utf8").split("\0").map((f) => f.replace(/^\n/, ""));
      const entries: BackupEntry[] = [];
      for (let i = 0; i + 2 < fields.length; i += 3) {
        const ref = fields[i]!;
        if (!ref.startsWith(root)) continue;
        const branch = ref.slice(root.length);
        const parsed = parseBackupBranch(branch);
        const time = Number(fields[i + 2]);
        if (!parsed || !OID.test(fields[i + 1]!) || !Number.isFinite(time)) continue;
        entries.push({ branch, ...parsed, tip: fields[i + 1]!, protectedThrough: time * 1000 });
      }
      return entries.sort((a, b) => (a.branch < b.branch ? -1 : a.branch > b.branch ? 1 : 0));
    },

    async listSnapshots(repo, branch, path, options = {}) {
      const { real, git } = await openRepo(repo);
      const ref = privateRef(branch);
      const args = ["log", "-z", "--first-parent", "--no-color", "--format=%H%x1f%ct%x1f%ce", ref];
      if (path !== undefined) args.push("--", `:(literal)${cleanRelative(path).join("/")}`);
      const found = await git.run(args, run(real, deps.localTimeoutMs, options.signal));
      if (found.code !== 0) throw new RestoreRefusedError("bad-snapshot", "that backup branch has not been fetched; list the backups first");
      const limit = options.limit ?? 500;
      const out: SnapshotInfo[] = [];
      for (const record of splitNul(found.stdout)) {
        const [id, time, email] = record.split("\x1f");
        if (!id || email !== deps.authorEmail || !OID.test(id)) continue;
        out.push({ id, time: Number(time) * 1000 });
        if (out.length >= limit) break;
      }
      return out;
    },

    async readAtSnapshot(repo, snapshot, path, options = {}) {
      const { real, git } = await openRepo(repo);
      return (await readBlob(real, git, snapshot, path, options.signal)).bytes;
    },

    async restoreFile(repo, snapshot, path, options = {}) {
      const { real, git } = await openRepo(repo);
      const { bytes, executable, parts } = await readBlob(real, git, snapshot, path, options.signal);
      const targetParts = options.targetPath === undefined ? parts : cleanRelative(options.targetPath);
      let target = targetParts;
      options.signal?.throwIfAborted();
      let dir = await ensureDirs(real, target);
      let state = await existing(join(dir, target[target.length - 1]!));
      let sibling = false;
      if (state.kind === "file") {
        if (state.bytes.equals(bytes)) return { state: "unchanged", path: target.join("/"), sibling: false, bytes: bytes.length };
        if (options.overwrite !== true) {
          if (options.targetPath !== undefined) {
            throw new RestoreRefusedError("target-exists", "the target has different content; choose another name or set overwrite");
          }
          target = siblingName(target.join("/"), deps.now()).split("/");
          dir = await ensureDirs(real, target);
          state = await existing(join(dir, target[target.length - 1]!));
          if (state.kind === "file") {
            if (state.bytes.equals(bytes)) return { state: "unchanged", path: target.join("/"), sibling: true, bytes: bytes.length };
            throw new RestoreRefusedError("target-exists", "a restored copy with this name already exists and differs");
          }
          sibling = true;
        }
      }
      await writeAtomic(dir, target[target.length - 1]!, bytes, executable);
      return { state: "restored", path: target.join("/"), sibling, bytes: bytes.length };
    },
  };
}

function openFile(path: string, mode: number) {
  return openHandle(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode);
}
