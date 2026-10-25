/**
 * The settings file on disk. Ported from Agent Traffic Control's `OwnedJsonFile`, with a cross-process lock added.
 *
 * Reading: a regular file only (never a symlink or FIFO), at most `maxBytes` (1 MB), read without blocking. A file that does not parse
 * (or is too large, or `accept` rejects) is reported `damaged`; `update` sets it aside as `<name>.damaged-<timestamp>` (0600; the 3
 * newest kept) under the lock, so no save overwrites it. When it cannot be set aside, the update is refused with
 * `problem: "unarchived"` and the file left as it is. When it was set aside and the update then lost the lock, the retry still treats a
 * missing file as that damaged file, so the recovery (defaults and its entry) is written all the same.
 *
 * Writing: every change goes through `update`: lock → sweep temporary files left by dead writers → read the file again → set a damaged
 * file aside → the caller's function → temporary file → commit rename → folder checked again → unlock. The temporary file is created
 * exclusively (O_EXCL, 0600, no symlink follow) in the same folder and fsynced; after the rename the folder is fsynced, so a crash
 * leaves the old file or the new one. Updates from one process run one after another.
 *
 * Checks. C (containment): the folder is not a link and resolves (realpath) to `root` (default: the folder itself, as first seen), and
 * settings.json, if there, is a regular file. F (folder): the folder is not a link, resolves to the root, and has the device and inode
 * it had when the lock was taken. L (lock): the lock is still this process's (`held()`). C is checked before every read and at the start
 * of every attempt; a failure refuses the update (code `refused`) and touches nothing more. A lost lock drops the attempt untouched and
 * runs the whole update again, within the lock wait.
 *
 * Before each call that changes the folder, its check is the last thing awaited; names are chosen and files inspected before it:
 * - mkdir of the folder at the start of an update: C only (the folder may not exist yet, so there is no device and inode to compare).
 * - the lock's own files (metadata temporary file, link, moving a lock aside, unlinking those): F, through `LockOptions.guard`.
 *   settings.json is not looked at, so a settings.json that became a link never keeps this process's lock alive.
 * - sweeping temporary files, setting a damaged file aside, pruning old `.damaged-` files, creating the temporary file, the commit
 *   rename: C + F + L.
 * - chmod 0600 of a set-aside file: on its open descriptor, only when that is the very file moved (device, inode) and F holds.
 * - unlinking this write's own temporary file when it was not committed: F (also after the lock was lost: the file is ours).
 * - the `beforeRename` test hook is awaited between the check and the commit rename only when a test sets it.
 * After each rename, F and the moved file's device and inode are checked again: a swap during the rename is detected, not undone.
 *
 * Threat model: these checks guard against a folder or file that is a link, or was swapped, before an operation (a misconfigured or
 * stale link). Node has no openat/renameat, so a path-based call can land elsewhere if the folder is swapped between its check and the
 * call; only a process of the same user can do that, and it could already write these files directly. Accepted residuals: (1) a race
 * between a check and its call (under a swap loop, lock-metadata temporary files and a moved lock can land in the other folder); (2) a
 * swap during a rename itself; (3) a `.damaged-` file created by someone else between the name check and the rename that sets a damaged
 * file aside is overwritten; (4) a lock lost between `held()` and the commit rename. When a check refuses, the files the lock or a
 * write left are not unlinked through a folder that is not the one locked; the sweep removes any `.<name>.<pid>.<hex>.tmp` (lock
 * metadata and moved locks included) once its process is dead or it is older than a minute.
 */
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { readBoundedFile } from "./bounded-read.ts";
import { acquireLock, LOCK_WAIT_MS, LockRefused, LockTimeout, pidAlive, tempPathOf, type Lock, type LockOptions } from "./lock.ts";

export const MAX_FILE_BYTES = 1024 * 1024;

export interface FileMessages {
  /** The folder or the file is a link. */
  linked: string;
  /** The folder no longer resolves to the root. */
  outside: string;
  /** The write failed (disk full, permissions). */
  unwritten: string;
  /** Another process held the lock past the wait. */
  locked: string;
  /** After `refuseWrites` (quitting). */
  closed: string;
  /** The value would make a file larger than `maxBytes`. */
  tooLarge: string;
  /** A damaged file could not be set aside, so nothing is written over it. */
  unarchived: string;
}

export const DEFAULT_FILE_MESSAGES: FileMessages = {
  linked: "Settings cannot be saved: the settings folder or the settings file is a link, not a plain file",
  outside: "Settings cannot be saved: the settings file is no longer inside the app's data folder",
  unwritten: "Settings could not be written to disk",
  locked: "The settings file is busy: another app or agent is changing it. Try again in a moment",
  closed: "Settings are closed; this change was not saved",
  tooLarge: "Too many settings changes to save",
  unarchived: "Settings cannot be saved: the damaged settings file could not be set aside, so it is left as it is",
};

/** A temporary file older than this is removed even when its process is alive. */
export const TEMP_MAX_AGE_MS = 60_000;
/** How many set-aside damaged files are kept (the newest). */
export const DAMAGED_KEPT = 3;

/** Test seams in the write path. Not for apps. */
export interface SettingsFileTestHooks {
  /** After every `read()`. */
  afterRead?(): Promise<void> | void;
  /** After the temporary file is written, before the lock and folder checks that precede the rename. */
  beforeCommit?(tmp: string): Promise<void> | void;
  /** After those checks, immediately before the rename. */
  beforeRename?(tmp: string): Promise<void> | void;
  /** Opens the folder for its fsync (default fs.open read-only). */
  openDir?(dir: string): Promise<Pick<FileHandle, "sync" | "close">>;
}

export interface SettingsFileOptions {
  /** The folder the file's folder must resolve to. Default: the file's folder as first seen. */
  root?: string;
  maxBytes?: number;
  lock?: LockOptions;
  messages?: Partial<FileMessages>;
  /** For the `.damaged-<timestamp>` name (default Date.now). */
  now?: () => number;
  /** Whether parsed JSON is a file this owner can use; false makes it `damaged` (set aside like text that does not parse). */
  accept?(raw: unknown): boolean;
  testHooks?: SettingsFileTestHooks;
}

/** What is on disk now. */
export type FileRead =
  | { kind: "missing" }
  | { kind: "ok"; raw: unknown }
  /** Not JSON, or too large. In `update`, `setAside` is where it went. */
  | { kind: "damaged"; setAside?: string }
  /** A link, a FIFO, a folder outside the root: neither read nor written. */
  | { kind: "refused"; error: string };

export type FileErrorCode = "locked" | "refused" | "unwritten" | "closed" | "too-large";
/** `problem: "unarchived"`: a damaged file could not be set aside; it is left as it is and nothing may use it until it can be. */
export type UpdateResult<T> =
  | { ok: true; result: T; written: boolean }
  | { ok: false; code: FileErrorCode; error: string; result?: T; problem?: "unarchived" };

/** What the caller's function in `update` returns: the value to write (undefined: write nothing) and its own result. */
export interface UpdateStep<T> {
  write?: unknown;
  result: T;
}

export class SettingsFile {
  readonly path: string;
  private readonly dir: string;
  private readonly root: string;
  private rootReal?: string;
  private readonly maxBytes: number;
  private readonly lockOpts: LockOptions;
  private readonly msg: FileMessages;
  private readonly now: () => number;
  private readonly accept: (raw: unknown) => boolean;
  private readonly hooks: SettingsFileTestHooks;
  private queue: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private closed: string | null = null;

  constructor(path: string, opts: SettingsFileOptions = {}) {
    this.path = path;
    this.dir = dirname(path);
    this.root = opts.root ?? this.dir;
    this.maxBytes = opts.maxBytes ?? MAX_FILE_BYTES;
    this.lockOpts = opts.lock ?? {};
    this.msg = { ...DEFAULT_FILE_MESSAGES, ...opts.messages };
    this.now = opts.now ?? Date.now;
    this.accept = opts.accept ?? (() => true);
    this.hooks = opts.testHooks ?? {};
  }

  get messages(): FileMessages {
    return this.msg;
  }

  /** Reads the file without the lock (writes are atomic renames, so a read sees a whole file). */
  async read(): Promise<FileRead> {
    const r = await this.readNow();
    await this.hooks.afterRead?.();
    return r;
  }

  private async readNow(): Promise<FileRead> {
    const err = await this.containment(false);
    if (err) return { kind: "refused", error: err };
    const r = await readBoundedFile(this.path, this.maxBytes);
    switch (r.kind) {
      case "missing":
        return { kind: "missing" };
      case "not-file":
        return { kind: "refused", error: this.msg.linked };
      case "error":
        return { kind: "refused", error: this.msg.unwritten };
      case "too-large":
        return { kind: "damaged" };
      case "ok":
        let raw: unknown;
        try {
          raw = JSON.parse(r.text) as unknown;
        } catch {
          return { kind: "damaged" };
        }
        return this.accept(raw) ? { kind: "ok", raw } : { kind: "damaged" };
    }
  }

  /**
   * Lock → read again → `step(read)` → write what it returns → unlock. A damaged file is set aside first and `step` sees
   * `{ kind: "damaged", setAside }`. Runs after every earlier update from this object.
   */
  update<T>(step: (read: FileRead) => UpdateStep<T> | Promise<UpdateStep<T>>): Promise<UpdateResult<T>> {
    this.queued++;
    const job = this.queue.then(() => this.run(step));
    this.queue = job.catch(() => undefined).finally(() => this.queued--);
    return job;
  }

  /** `read`, but after every update queued before it (no lock), so it never sees a file older than this object's last write. */
  readInOrder(): Promise<FileRead> {
    const job = this.queue.then(() => this.read());
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async run<T>(step: (read: FileRead) => UpdateStep<T> | Promise<UpdateStep<T>>): Promise<UpdateResult<T>> {
    if (this.closed !== null) return { ok: false, code: "closed", error: this.closed };
    const pre = await this.containment(false); // the guard for the mkdir below
    if (pre) return { ok: false, code: "refused", error: pre };
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
    } catch {
      return { ok: false, code: "unwritten", error: this.msg.unwritten };
    }
    const until = Date.now() + (this.lockOpts.waitMs ?? LOCK_WAIT_MS);
    // Where an earlier attempt of this update set a damaged file aside before it lost the lock: the retry still owes the recovery
    // (defaults and the damage entry), so a file still missing then is read as that damaged file, not as a first run.
    let recovered: string | undefined;
    for (;;) {
      const err = await this.containment(true);
      if (err) return { ok: false, code: "refused", error: err };
      const folder = await this.folderNow();
      if (!folder) return { ok: false, code: "refused", error: this.msg.outside };
      const place = this.placeGuard(folder);
      const folderOk = this.folderGuard(folder);
      let lock: Lock;
      try {
        // The lock's own files need only the folder: a settings.json that became a link must not keep this process's lock alive.
        lock = await acquireLock(this.path, { ...this.lockOpts, waitMs: Math.max(0, until - Date.now()), guard: folderOk });
      } catch (e) {
        if (e instanceof LockTimeout) return { ok: false, code: "locked", error: this.msg.locked };
        if (e instanceof LockRefused) return { ok: false, code: "refused", error: (await place()) ?? this.msg.outside };
        return { ok: false, code: "unwritten", error: this.msg.unwritten };
      }
      try {
        // The guard: awaited as the last step before every change to the folder, with nothing awaited between it and the call.
        const guard = async (): Promise<string | typeof LOST | null> => (await place()) ?? ((await lock.held()) ? null : LOST);
        const lost = (result?: T): UpdateResult<T> | null =>
          Date.now() >= until ? { ok: false, code: "locked", error: this.msg.locked, ...(result !== undefined ? { result } : {}) } : null;
        const swept = await this.sweepNow(guard);
        if (swept === LOST) {
          const gave = lost();
          if (gave) return gave;
          continue;
        }
        if (swept) return { ok: false, code: "refused", error: swept };
        let read = await this.read();
        if (read.kind === "missing" && recovered !== undefined) read = { kind: "damaged", setAside: recovered };
        else if (read.kind === "damaged") {
          const a = await this.setAside(folder, guard, folderOk);
          if (a === LOST) {
            const gave = lost();
            if (gave) return gave;
            continue; // not set aside: nothing was touched; run the whole update again
          }
          if (a.kind === "refused") return { ok: false, code: "refused", error: a.error };
          if (a.kind === "unarchived") return { ok: false, code: "refused", error: this.msg.unarchived, problem: "unarchived" };
          recovered = a.to;
          read = { kind: "damaged", setAside: a.to };
        } else recovered = undefined; // the file is there (or refused): whatever is on disk now is what this update works from
        const s = await step(read);
        if (s.write === undefined) return { ok: true, result: s.result, written: false };
        if (read.kind === "refused") return { ok: false, code: "refused", error: read.error, result: s.result };
        const text = JSON.stringify(s.write, null, 2) + "\n";
        if (Buffer.byteLength(text, "utf8") > this.maxBytes) return { ok: false, code: "too-large", error: this.msg.tooLarge, result: s.result };
        const werr = await this.write(text, folder, guard, folderOk);
        if (werr === LOST) {
          const gave = lost(s.result);
          if (gave) return gave;
          continue; // the lock was taken from us before the commit: nothing was written; run the whole update again
        }
        if (werr) return { ok: false, code: werr === this.msg.unwritten ? "unwritten" : "refused", error: werr, result: s.result };
        return { ok: true, result: s.result, written: true };
      } finally {
        await lock.release();
      }
    }
  }

  /**
   * Removes temporary files (`.<name>.<pid>.<hex>.tmp`) whose process is dead or that are older than a minute, taking the lock if it is
   * free at once. For opening; `update` does the same under its lock.
   */
  async sweep(): Promise<void> {
    if ((await this.containment(false)) !== null) return;
    if (!(await lstat(this.dir).catch(() => null))) return;
    if ((await this.containment(true)) !== null) return;
    const folder = await this.folderNow();
    if (!folder) return;
    const place = this.placeGuard(folder);
    let lock: Lock;
    try {
      lock = await acquireLock(this.path, { ...this.lockOpts, waitMs: 0, guard: this.folderGuard(folder) });
    } catch {
      return; // busy (its holder sweeps), the folder cannot be written, or it failed the guard
    }
    try {
      await this.sweepNow(async () => (await place()) ?? ((await lock.held()) ? null : LOST));
    } finally {
      await lock.release();
    }
  }

  /** The folder guard: containment, and the folder is still `folder` (realpath, device, inode). Null when the folder may be changed. */
  private placeGuard(folder: Folder): () => Promise<string | null> {
    return async () => (await this.containment(true)) ?? (sameFolder(folder, await this.folderNow()) ? null : this.msg.outside);
  }

  /**
   * The folder check alone: the folder is not a link, resolves to the root, and is still `folder` (device, inode). For the lock's own
   * files and for removing this process's own temporary files; settings.json itself is not looked at.
   */
  private folderGuard(folder: Folder): FolderFn {
    return async () => sameFolder(folder, await this.folderNow());
  }

  /** Removes the dead writers' temporary files; each unlink right after `guard`. Returns what the guard refused with, or null. */
  private async sweepNow(guard: () => Promise<string | typeof LOST | null>): Promise<string | typeof LOST | null> {
    const base = basename(this.path);
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return null;
    }
    const prefix = `.${base}.`;
    for (const n of names) {
      if (!n.startsWith(prefix) || !n.endsWith(".tmp")) continue;
      const m = /^(\d+)\.[0-9a-f]+\.tmp$/.exec(n.slice(prefix.length));
      if (!m) continue;
      const p = join(this.dir, n);
      const st = await lstat(p).catch(() => null);
      if (!st || !st.isFile()) continue;
      if (pidAlive(Number(m[1])) && Date.now() - st.mtimeMs <= TEMP_MAX_AGE_MS) continue;
      const g = await guard();
      if (g) return g;
      await unlink(p).catch(() => undefined);
    }
    return null;
  }

  /** Quitting: every later update is refused with `reason`, and nothing more is queued for the disk. */
  refuseWrites(reason?: string): void {
    this.closed = reason ?? this.msg.closed;
  }

  pending(): number {
    return this.queued;
  }

  flush(): Promise<void> {
    return this.queue.then(() => undefined);
  }

  /** True when every queued update finished within `ms`. */
  async flushWithin(ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<false>((r) => (timer = setTimeout(() => r(false), ms)));
    try {
      return await Promise.race([this.flush().then(() => true as const), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Why the file may not be touched, or null. */
  private async containment(created: boolean): Promise<string | null> {
    try {
      if ((await lstat(this.dir)).isSymbolicLink()) return this.msg.linked;
    } catch (e) {
      if (!created && (e as NodeJS.ErrnoException).code === "ENOENT") return null; // nothing there yet
      return this.msg.outside;
    }
    try {
      this.rootReal ??= await realpath(this.root);
      if ((await realpath(this.dir)) !== this.rootReal) return this.msg.outside;
    } catch (e) {
      if (!created && (e as NodeJS.ErrnoException).code === "ENOENT") return null;
      return this.msg.outside;
    }
    const cur = await lstat(this.path).catch(() => null);
    if (cur && !cur.isFile()) return this.msg.linked;
    return null;
  }

  /**
   * Moves a damaged file to `<name>.damaged-<timestamp>` (never over an existing one), private (0600). The name is chosen and the files
   * inspected first; `guard` is the last await before the rename. After it, the folder and the moved file's inode are checked again
   * (detected, not prevented: a mismatch touches nothing more).
   */
  private async setAside(folder: Folder, guard: GuardFn, folderOk: FolderFn): Promise<SetAside | typeof LOST> {
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, "-");
    for (let i = 0; i < 100; i++) {
      const to = `${this.path}.damaged-${stamp}${i ? `-${i}` : ""}`;
      if (await lstat(to).catch(() => null)) continue;
      const was = await lstat(this.path).catch(() => null);
      if (!was?.isFile()) return { kind: "unarchived" };
      const g = await guard();
      if (g === LOST) return LOST;
      if (g) return { kind: "refused", error: g };
      try {
        await rename(this.path, to);
      } catch {
        return { kind: "unarchived" };
      }
      if (!sameFolder(folder, await this.folderNow())) return { kind: "refused", error: this.msg.outside };
      const moved = await lstat(to).catch(() => null);
      if (!moved || moved.dev !== was.dev || moved.ino !== was.ino) return { kind: "refused", error: this.msg.outside };
      try {
        const fh = await open(to, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
        try {
          const st = await fh.stat();
          // chmod acts on this descriptor, not a path: only when it is the very file moved, and the folder is still the one locked.
          if (st.isFile() && st.dev === was.dev && st.ino === was.ino && (await folderOk())) await fh.chmod(0o600);
        } finally {
          await fh.close();
        }
      } catch {
        /* moved aside all the same; nothing more can be done here */
      }
      await this.pruneDamaged(guard);
      return { kind: "moved", to };
    }
    return { kind: "unarchived" };
  }

  /** Keeps the newest `DAMAGED_KEPT` set-aside files (by the timestamp in their names); removes older ones, each right after `guard`. */
  private async pruneDamaged(guard: GuardFn): Promise<void> {
    const prefix = `${basename(this.path)}.damaged-`;
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    const ours = names
      .map((n) => ({ n, m: n.startsWith(prefix) ? /^(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z)(?:-(\d{1,2}))?$/.exec(n.slice(prefix.length)) : null }))
      .filter((x): x is { n: string; m: RegExpExecArray } => x.m !== null)
      .sort((a, b) => (a.m[1]! < b.m[1]! ? 1 : a.m[1]! > b.m[1]! ? -1 : Number(b.m[2] ?? 0) - Number(a.m[2] ?? 0)));
    for (const { n } of ours.slice(DAMAGED_KEPT)) {
      const p = join(this.dir, n);
      if (!(await lstat(p).catch(() => null))?.isFile()) continue;
      if ((await guard()) !== null) return;
      await unlink(p).catch(() => undefined);
    }
  }

  /** The folder as it is now: its device and inode, if it is a real folder that resolves to the root. */
  private async folderNow(): Promise<Folder | null> {
    try {
      const st = await lstat(this.dir);
      if (!st.isDirectory()) return null;
      if ((await realpath(this.dir)) !== this.rootReal) return null;
      return { dev: st.dev, ino: st.ino };
    } catch {
      return null;
    }
  }

  /**
   * `guard` → temporary file → `guard` → rename → folder checked again. `folder` is the folder as locked. The guard is the last await
   * before opening the temporary file and before the rename; the folder check alone before unlinking this write's own temporary file
   * when it was not committed (also when the lock was lost: the file is this process's, and nobody else removes it while it is alive).
   */
  private async write(text: string, folder: Folder, guard: GuardFn, folderOk: FolderFn): Promise<string | typeof LOST | null> {
    const same = (f: Folder | null) => sameFolder(folder, f);
    let tmp: string | undefined;
    let renamed = false;
    try {
      const name = tempPathOf(this.path);
      const g0 = await guard();
      if (g0) return g0;
      const fh = await open(name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      tmp = name;
      let written;
      try {
        await fh.writeFile(text, "utf8");
        await fh.sync();
        written = await fh.stat();
      } finally {
        await fh.close();
      }
      await this.hooks.beforeCommit?.(tmp);
      const g = await guard();
      if (g) return g;
      if (this.hooks.beforeRename) await this.hooks.beforeRename(tmp); // test seam only: nothing is awaited here in an app
      await rename(tmp, this.path);
      renamed = true;
      // Detected, not prevented: a folder swapped during the rename. Everything is left as it is.
      if (!same(await this.folderNow())) return this.msg.outside;
      const now = await lstat(this.path).catch(() => null);
      if (!now || now.dev !== written.dev || now.ino !== written.ino) return this.msg.outside;
      await syncDir(this.dir, this.hooks.openDir);
      return null;
    } catch {
      return this.msg.unwritten;
    } finally {
      if (tmp && !renamed && (await folderOk().catch(() => false))) await unlink(tmp).catch(() => undefined);
    }
  }
}

const LOST = Symbol("lock lost");
type GuardFn = () => Promise<string | typeof LOST | null>;
type FolderFn = () => Promise<boolean>;
type SetAside = { kind: "moved"; to: string } | { kind: "refused"; error: string } | { kind: "unarchived" };

interface Folder {
  dev: number;
  ino: number;
}
const sameFolder = (a: Folder, b: Folder | null): boolean => !!b && a.dev === b.dev && a.ino === b.ino;

/** Errors that mean "this platform cannot fsync a folder", as opposed to a failed fsync. */
const DIR_OPEN_UNSUPPORTED = new Set(["EISDIR", "EPERM", "EACCES", "EINVAL", "ENOTSUP", "EOPNOTSUPP"]);
const DIR_SYNC_UNSUPPORTED = new Set(["EINVAL", "ENOTSUP", "EOPNOTSUPP"]);
/** Windows opens a folder read-only but refuses to flush it: libuv reports EPERM. Elsewhere EPERM stays an error. */
const dirSyncUnsupported = (code: string, platform: NodeJS.Platform): boolean =>
  DIR_SYNC_UNSUPPORTED.has(code) || (platform === "win32" && code === "EPERM");

/**
 * fsync the folder so the rename itself is on disk. A platform that cannot open or fsync a folder (EISDIR, EPERM/EACCES on opening it,
 * EINVAL, ENOTSUP, EPERM on fsyncing it on Windows) is not an error; any other failure (EIO) is thrown: the update may not survive a power cut.
 */
export async function syncDir(
  dir: string,
  openDir: (dir: string) => Promise<Pick<FileHandle, "sync" | "close">> = (d) => open(d, constants.O_RDONLY),
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  let fh;
  try {
    fh = await openDir(dir);
  } catch (e) {
    if (DIR_OPEN_UNSUPPORTED.has((e as NodeJS.ErrnoException).code ?? "")) return;
    throw e;
  }
  try {
    await fh.sync();
  } catch (e) {
    if (!dirSyncUnsupported((e as NodeJS.ErrnoException).code ?? "", platform)) throw e;
  } finally {
    await fh.close().catch(() => undefined);
  }
}
