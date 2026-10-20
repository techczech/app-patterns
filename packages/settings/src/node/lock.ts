/**
 * The cross-process lock on a settings file (invariant 4): `<file>.lock`, holding `{ pid, at, nonce, host }`.
 *
 * Taking it: the metadata is written to a private temporary file first, which is then hard-linked to `<file>.lock` (`link()` is atomic
 * and fails when the lock exists). So a lock never exists without its metadata.
 *
 * Stale: its process is dead (same host, `process.kill(pid, 0)` says ESRCH), or it is older than the lease (30 s; no legitimate update
 * holds the lock that long, so a reused pid cannot keep a dead writer's lock alive). A lock whose text does not parse (not written by
 * this code) is judged by the lease alone.
 *
 * Breaking a stale lock, and releasing one's own: rename the lock to a private name, then read it there. If it is the lock judged, it
 * stays removed. If it is not (another waiter broke the stale one and someone took a fresh lock in between), the breaker lost the race:
 * it deletes its moved copy too and never puts a lock back. The fresh lock's owner then fails `held()` and runs its update again, so a
 * lost race costs a retry, never a lost change. Release first checks `held()`, so it only moves aside a lock that was its own a moment
 * before.
 *
 * `held()`: `<file>.lock` is the very file this holder linked (same device and inode) and holds its nonce. The holder checks it
 * immediately before every destructive step (setting a damaged file aside, and the rename that commits a write); a holder that lost the
 * lock (evicted after the lease, or its lock moved by a breaker) aborts and starts the update again. The one window not covered is a
 * lock lost between that check and the rename itself.
 *
 * Containment: the lock lives in the settings folder, so each of its own changes there (creating the metadata file, the link, moving
 * a lock aside, unlinking those) awaits `opts.guard` as the last step before the call; names are chosen and files inspected before
 * it. A refused guard changes nothing and leaves the private files where they are (`.<name>.<pid>.<hex>.tmp`, which the settings
 * file's sweep removes). The guard narrows a race with a same-user process swapping the folder; it cannot close it.
 */
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, rename, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { readBoundedFile } from "./bounded-read.ts";

export interface LockOptions {
  /** Give up after this long (default 5000 ms). */
  waitMs?: number;
  /** A lock older than this is stale whoever holds it (default 30 000 ms). */
  leaseMs?: number;
  /** The clock for `at` and for judging a lock's age (default Date.now). */
  now?: () => number;
  /**
   * Whether the folder may still be changed (the settings file passes its containment check). Awaited as the last step before every
   * change the lock makes to the folder (creating its temporary file, the link, moving a lock aside, unlinking); false refuses that
   * change. Default: always.
   */
  guard?: Guard;
}

/** See `LockOptions.guard`. */
export type Guard = () => Promise<boolean>;
const always: Guard = async () => true;

/** The folder failed `guard`: nothing was changed. */
export class LockRefused extends Error {
  constructor(readonly path: string) {
    super(`Refused to change ${path}: the folder is not the one checked`);
  }
}

export const LOCK_WAIT_MS = 5_000;
export const LOCK_LEASE_MS = 30_000;

export class LockTimeout extends Error {
  constructor(readonly path: string) {
    super(`Timed out waiting for ${path}`);
  }
}

/** A lock this process holds. */
export interface Lock {
  readonly path: string;
  readonly nonce: string;
  /** Whether `<file>.lock` still holds this lock's nonce. */
  held(): Promise<boolean>;
  /** Removes the lock if it is still this one. */
  release(): Promise<void>;
}

interface Meta {
  pid: number;
  at: number;
  nonce: string;
  host?: string;
}

const MAX_LOCK_BYTES = 4096;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const lockPathOf = (file: string): string => `${file}.lock`;

/**
 * A fresh private name next to `file`: `.<name>.<pid>.<hex>.tmp`. Data writes, lock metadata and moved-aside locks all use it, so one
 * sweep clears what a crashed process left.
 */
export function tempPathOf(file: string): string {
  return join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
}

/** Whether a process with this pid exists (EPERM: it exists, owned by someone else). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseMeta(text: string): Meta | undefined {
  try {
    const j = JSON.parse(text) as Partial<Meta>;
    if (typeof j.pid !== "number" || typeof j.at !== "number" || !Number.isFinite(j.at) || typeof j.nonce !== "string") return undefined;
    return { pid: j.pid, at: j.at, nonce: j.nonce, ...(typeof j.host === "string" ? { host: j.host } : {}) };
  } catch {
    return undefined;
  }
}

/** The text, device and inode of a lock file, or null when there is none. */
async function look(path: string): Promise<{ dev: number; ino: number; mtimeMs: number; text: string } | null> {
  let st;
  try {
    st = await lstat(path);
  } catch {
    return null;
  }
  const r = await readBoundedFile(path, MAX_LOCK_BYTES);
  if (r.kind === "missing") return null;
  return { dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs, text: r.kind === "ok" ? r.text : "" };
}

function stale(seen: { mtimeMs: number; text: string }, leaseMs: number, now: number): boolean {
  const m = parseMeta(seen.text);
  const at = m ? Math.min(m.at, seen.mtimeMs) : seen.mtimeMs; // a stamp in the future cannot keep a lock alive
  if (now - at > leaseMs) return true;
  return m !== undefined && (m.host === undefined || m.host === hostname()) && !pidAlive(m.pid);
}

export interface MoveHooks {
  /** Test seam: runs between moving a lock aside and judging it. */
  afterMove?(): Promise<void> | void;
  /** As `LockOptions.guard`. */
  guard?: Guard;
}

/**
 * Moves `<file>.lock` aside and removes it. True when `is(text, ino)` says it was the lock meant. False when it was not (a fresh lock
 * taken after the judgement): that lock is removed all the same, never put back, and its owner learns it lost the lock from `held()`.
 */
export async function removeLockIf(file: string, is: (text: string, ino: number) => boolean, hooks: MoveHooks = {}): Promise<boolean> {
  const path = lockPathOf(file);
  const aside = tempPathOf(file);
  const guard = hooks.guard ?? always;
  try {
    if (!(await guard())) return false;
    await rename(path, aside);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
  try {
    await hooks.afterMove?.();
    const seen = await look(aside);
    // Not the lock meant: this breaker lost the race. Putting it back could hand a lock to an owner whose read is already stale
    // (another writer may have taken the free path, committed and released meanwhile), so it is deleted and its owner retries.
    return !!seen && is(seen.text, seen.ino);
  } finally {
    // A folder that failed the guard keeps the moved copy (a `.tmp` name: a later sweep removes it).
    if (await guard().catch(() => false)) await unlink(aside).catch(() => undefined);
  }
}

function handle(file: string, nonce: string, id: { dev: number; ino: number }, guard: Guard): Lock {
  const path = lockPathOf(file);
  const held = async () => {
    const seen = await look(path);
    return !!seen && seen.dev === id.dev && seen.ino === id.ino && parseMeta(seen.text)?.nonce === nonce;
  };
  return {
    path,
    nonce,
    held,
    release: async () => {
      // Only a lock that is still ours is moved aside; one lost meanwhile (evicted, broken) is someone else's now.
      if (!(await held().catch(() => false))) return;
      await removeLockIf(file, (text, ino) => ino === id.ino && parseMeta(text)?.nonce === nonce, { guard }).catch(() => false);
    },
  };
}

async function create(file: string, now: () => number, guard: Guard): Promise<Lock | "exists"> {
  const nonce = randomBytes(12).toString("hex");
  const tmp = tempPathOf(file);
  if (!(await guard())) throw new LockRefused(lockPathOf(file));
  const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    let id;
    try {
      await fh.writeFile(JSON.stringify({ pid: process.pid, at: now(), nonce, host: hostname() } satisfies Meta), "utf8");
      id = await fh.stat(); // the lock below is a hard link to this very file: same device and inode
    } finally {
      await fh.close();
    }
    try {
      if (!(await guard())) throw new LockRefused(lockPathOf(file));
      await link(tmp, lockPathOf(file));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return "exists";
      throw e;
    }
    return handle(file, nonce, { dev: id.dev, ino: id.ino }, guard);
  } finally {
    if (await guard().catch(() => false)) await unlink(tmp).catch(() => undefined);
  }
}

/** Removes `<file>.lock` if it is stale. True when it was removed or was gone (try again at once). */
async function breakStale(file: string, leaseMs: number, now: () => number, guard: Guard): Promise<boolean> {
  const seen = await look(lockPathOf(file));
  if (!seen) return true;
  if (!stale(seen, leaseMs, now())) return false;
  return removeLockIf(file, (text, ino) => ino === seen.ino && text === seen.text, { guard });
}

/**
 * Takes the lock on `file` (`<file>.lock`), waiting up to `waitMs`; throws `LockTimeout` after that. With `waitMs: 0` it tries once.
 * Errors other than "someone holds it" (a read-only folder, a file system without hard links) are thrown as they are; `LockRefused`
 * when `opts.guard` refused a change.
 */
export async function acquireLock(file: string, opts: LockOptions = {}): Promise<Lock> {
  const waitMs = opts.waitMs ?? LOCK_WAIT_MS;
  const leaseMs = opts.leaseMs ?? LOCK_LEASE_MS;
  const now = opts.now ?? Date.now;
  const guard = opts.guard ?? always;
  const until = Date.now() + waitMs;
  let delay = 2;
  let quick = 0;
  for (;;) {
    const h = await create(file, now, guard);
    if (h !== "exists") return h;
    if ((await breakStale(file, leaseMs, now, guard)) && quick++ < 20) continue;
    if (Date.now() >= until) throw new LockTimeout(lockPathOf(file));
    await sleep(Math.min(delay, Math.max(1, until - Date.now())) * (0.5 + Math.random()));
    delay = Math.min(delay * 2, 40);
  }
}

/** Runs `fn` holding the lock on `file`. */
export async function withLock<T>(file: string, opts: LockOptions, fn: (lock: Lock) => Promise<T>): Promise<T> {
  const lock = await acquireLock(file, opts);
  try {
    return await fn(lock);
  } finally {
    await lock.release();
  }
}
