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
import { link, lstat, mkdir, open as openHandle, readFile, realpath, rename, rm, rmdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, sep } from "node:path";
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

/** Test seam: runs after the target was checked and before the file is published. */
export const restoreTestHooks: { beforePublish?: (target: string) => void | Promise<void> } = {};

const SNAPSHOT_BATCH = 200;
const SNAPSHOT_SCAN_LIMIT = 20000;
const SIBLING_ATTEMPTS = 20;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function privateRoot(remote: string): string {
  return `refs/vault-sync/backups/${remote}/`;
}

export function parseBackupBranch(name: string): { machine: string; checkout: string; date: string } | null {
  const parts = name.split("/");
  if (parts.length !== 4 || parts[0] !== "backup") return null;
  if (!DAY.test(parts[3]!)) return null;
  try {
    return { machine: validateId("machine id", parts[1]!), checkout: validateId("checkout id", parts[2]!), date: parts[3]! };
  } catch {
    return null;
  }
}

const HFS_IGNORABLE = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;

/**
 * True when a path component names .git on some filesystem: plain or case variants, HFS+ names with
 * ignorable code points, NTFS names with trailing dots/spaces or a data-stream suffix, and the 8.3
 * short name GIT~1. Mirrors git's is_hfs_dotgit and is_ntfs_dotgit.
 */
export function isDotGitName(part: string): boolean {
  const plain = part.normalize("NFC");
  if (plain.replace(HFS_IGNORABLE, "").toLowerCase() === ".git") return true;
  return /^(?:\.git|git~1)[ .]*(?::.*)?$/i.test(plain.replace(HFS_IGNORABLE, ""));
}

/** A worktree-relative path with no empty, "." or ".." parts, no NUL, no backslash and nothing under .git. */
function cleanRelative(path: string): string[] {
  if (typeof path !== "string" || path === "" || path.includes("\0") || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    throw new RestoreRefusedError("unsafe-path", "the path must be relative to the folder");
  }
  const parts = path.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..") || parts.some(isDotGitName)) {
    throw new RestoreRefusedError("unsafe-path", "the path must stay inside the folder and outside .git");
  }
  return parts;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function siblingName(path: string, ms: number, n = 1): string {
  const d = new Date(ms);
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
  const dir = dirname(path);
  const ext = extname(path);
  const stem = basename(path, ext);
  const name = `${stem} (restored ${stamp}${n > 1 ? ` ${n}` : ""})${ext}`;
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
    await git.ok(["fetch", "--quiet", "--prune", "--no-tags", "--no-write-fetch-head", "--no-recurse-submodules", "--no-auto-gc", "--refmap=", deps.remote, `+refs/heads/backup/*:${dst}`], run(real, deps.networkTimeoutMs, signal));
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

  /** True when `dir` resolves to a real directory inside the real worktree root (same inode as the walked path). */
  async function insideRoot(root: string, dir: string): Promise<boolean> {
    const resolved = await realpath(dir);
    if (resolved !== root && !resolved.startsWith(root.endsWith(sep) ? root : root + sep)) return false;
    // Compare by device and inode, not by path text: a differently cased or normalised name for the same
    // folder is the same folder on case-insensitive volumes.
    const [walked, real] = await Promise.all([stat(dir), stat(resolved)]);
    return walked.dev === real.dev && walked.ino === real.ino;
  }

  /** Walks the target's directories, creating missing ones, refusing any symlink or non-directory. */
  async function ensureDirs(root: string, parts: string[], created: string[]): Promise<string> {
    let current = root;
    for (const part of parts.slice(0, -1)) {
      current = join(current, part);
      let info;
      try {
        info = await lstat(current);
      } catch {
        await mkdir(current);
        created.push(current);
        info = await lstat(current);
      }
      if (info.isSymbolicLink()) throw new RestoreRefusedError("beyond-symlink", "a folder on the way to the target is a symbolic link");
      if (!info.isDirectory()) throw new RestoreRefusedError("unsafe-path", "a file is in the way of the target folder");
    }
    if (!(await insideRoot(root, current))) {
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

  /** Writes the bytes to a short, fixed-length temp name in `dir` and returns its path. */
  async function stage(dir: string, bytes: Buffer, executable: boolean): Promise<string> {
    const temp = join(dir, `.vsr-${randomBytes(8).toString("hex")}.tmp`);
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
    return temp;
  }

  /**
   * Publishes without replacing: a hard link fails with EEXIST if anything appeared at `file` since the
   * check. Returns false on EEXIST. Where links are unsupported, falls back to a last-moment existence
   * check and rename.
   */
  async function publishNew(temp: string, file: string): Promise<boolean> {
    try {
      await link(temp, file);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return false;
      if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EXDEV" && code !== "ENOSYS") throw error;
    }
    try {
      await lstat(file);
      return false;
    } catch { /* absent */ }
    await rename(temp, file);
    return true;
  }

  async function removeCreated(created: string[]): Promise<void> {
    // Only folders this call created, deepest first, only if empty (rmdir refuses otherwise).
    for (const dir of [...created].reverse()) await rmdir(dir).catch(() => undefined);
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
      const filter = path === undefined ? null : `:(literal)${cleanRelative(path).join("/")}`;
      const limit = Math.max(1, Math.floor(options.limit ?? 500));
      // Engine commits are recognised by the engine identity on author OR committer: either one alone
      // identifies a snapshot, and matching both would drop commits if a Git config rewrote one of them.
      const isEngine = (author: string | undefined, committer: string | undefined) => author === deps.authorEmail || committer === deps.authorEmail;
      const parse = (record: string) => {
        const [id, time, author, committer] = record.split("\x1f");
        return id && OID.test(id) ? { id, time: Number(time) * 1000, engine: isEngine(author, committer) } : null;
      };
      const format = "--format=%H%x1f%ct%x1f%ae%x1f%ce";
      // A chain's first snapshot has the user's HEAD as first parent, so walk newest first in bounded
      // batches and stop at the first commit that is not the engine's.
      const chain: SnapshotInfo[] = [];
      let boundary: string | null = null;
      let skip = 0;
      scan: while (skip < SNAPSHOT_SCAN_LIMIT) {
        const found = await git.run(["log", "-z", "--first-parent", "--no-color", `--max-count=${SNAPSHOT_BATCH}`, `--skip=${skip}`, format, ref], run(real, deps.localTimeoutMs, options.signal));
        if (found.code !== 0) throw new RestoreRefusedError("bad-snapshot", "that backup branch has not been fetched; list the backups first");
        const records = splitNul(found.stdout);
        for (const record of records) {
          const row = parse(record);
          if (!row) continue;
          if (!row.engine) {
            boundary = row.id;
            break scan;
          }
          chain.push({ id: row.id, time: row.time });
          if (!filter && chain.length >= limit) break scan;
        }
        if (records.length < SNAPSHOT_BATCH) break;
        skip += records.length;
      }
      if (!filter) return chain.slice(0, limit);
      const args = ["log", "-z", "--first-parent", "--no-color", `--max-count=${boundary ? limit : SNAPSHOT_SCAN_LIMIT}`, format, ref];
      if (boundary) args.push(`^${boundary}`);
      args.push("--", filter);
      const found = await git.run(args, run(real, deps.localTimeoutMs, options.signal));
      if (found.code !== 0) throw new RestoreRefusedError("bad-snapshot", "that backup branch has not been fetched; list the backups first");
      const out: SnapshotInfo[] = [];
      for (const record of splitNul(found.stdout)) {
        const row = parse(record);
        if (!row || !row.engine) continue;
        out.push({ id: row.id, time: row.time });
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
      const target = options.targetPath === undefined ? parts : cleanRelative(options.targetPath);
      const explicit = options.targetPath !== undefined;
      const overwrite = options.overwrite === true;
      options.signal?.throwIfAborted();
      const created: string[] = [];
      let temp: string | null = null;
      try {
        const dir = await ensureDirs(real, target, created);
        const names = [target];
        if (!overwrite && !explicit) {
          for (let n = 1; n <= SIBLING_ATTEMPTS; n += 1) names.push(siblingName(target.join("/"), deps.now(), n).split("/"));
        }
        for (let i = 0; i < names.length; i += 1) {
          const file = join(dir, names[i]![names[i]!.length - 1]!);
          const done = async (state: RestoreResult["state"]): Promise<RestoreResult> => {
            const result: RestoreResult = { state, path: names[i]!.join("/"), sibling: i > 0, bytes: bytes.length };
            if (state === "restored") await checkStillInside(file);
            return result;
          };
          // Twice: a file that appears between the check and the publish is looked at once more.
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const state = await existing(file);
            if (state.kind === "file" && state.bytes.equals(bytes)) return await done("unchanged");
            if (state.kind === "file" && !overwrite) break;
            temp ??= await stage(dir, bytes, executable);
            await restoreTestHooks.beforePublish?.(file);
            if (overwrite) {
              await rename(temp, file);
              temp = null;
              return await done("restored");
            }
            if (await publishNew(temp, file)) return await done("restored");
          }
          if (explicit) throw new RestoreRefusedError("target-exists", "the target has different content; choose another name or set overwrite");
        }
        throw new RestoreRefusedError("target-exists", "restored copies with this name already exist and differ");
      } catch (error) {
        // The temp file goes first: a created folder is only removed when empty.
        if (temp) await rm(temp, { force: true });
        temp = null;
        await removeCreated(created);
        throw error;
      } finally {
        if (temp) await rm(temp, { force: true });
      }

      async function checkStillInside(file: string): Promise<void> {
        // A folder swapped for a symlink during the write must not leave a file outside the worktree.
        if (!(await insideRoot(real, dirname(file)).catch(() => false))) {
          await rm(file, { force: true });
          throw new RestoreRefusedError("beyond-symlink", "the target folder is not inside the folder");
        }
      }
    },
  };
}

function openFile(path: string, mode: number) {
  return openHandle(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), mode);
}
