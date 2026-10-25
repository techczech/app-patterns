/**
 * The engine's private folder inside a checkout's git directory: checkout identity, the deadline
 * record, the private index, an empty hooks directory and an operation lock shared by every
 * engine process on this machine. Nothing here is inside the worktree.
 */
import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { convertedRecord, emptyRecord, parseRecord, type DeadlineRecord } from "./deadline.ts";

export const ENGINE_FOLDER = "vault-sync";

export interface EngineFolder {
  dir: string;
  indexFile: string;
  hooksDir: string;
  recordFile: string;
  checkoutFile: string;
  /** Roots of snapshot chains this engine made here, and the newest tip already checked (chain.ts). */
  chainFile: string;
  /** Operation lock folder (capture, push, verify, enable) shared by every engine process on this machine. */
  lockDir: string;
  /** Short lock held only while the deadline record is read, changed and written. */
  recordLockDir: string;
  enablementFile: string;
}

export function engineFolder(gitDir: string): EngineFolder {
  const dir = join(gitDir, ENGINE_FOLDER);
  return {
    dir,
    indexFile: join(dir, "index"),
    hooksDir: join(dir, "hooks-disabled"),
    recordFile: join(dir, "deadline.json"),
    checkoutFile: join(dir, "checkout.json"),
    chainFile: join(dir, "chain.json"),
    lockDir: join(dir, "operation-lock"),
    recordLockDir: join(dir, "record-lock"),
    enablementFile: join(dir, "enablement.json"),
  };
}

export async function ensureEngineFolder(folder: EngineFolder): Promise<void> {
  await mkdir(folder.hooksDir, { recursive: true });
}

/** Returns this checkout's persisted id, creating it once (exclusive create, so two processes agree). */
export async function checkoutId(folder: EngineFolder): Promise<string> {
  const read = async (): Promise<string | null> => {
    try {
      const parsed = JSON.parse(await readFile(folder.checkoutFile, "utf8")) as { checkoutId?: unknown };
      return typeof parsed.checkoutId === "string" && /^[a-f0-9]{12}$/.test(parsed.checkoutId) ? parsed.checkoutId : null;
    } catch {
      return null;
    }
  };
  const existing = await read();
  if (existing) return existing;
  const id = randomBytes(6).toString("hex");
  try {
    await writeFile(folder.checkoutFile, `${JSON.stringify({ checkoutId: id, createdAt: new Date().toISOString() })}\n`, { flag: "wx" });
    return id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const raced = await read();
    if (raced) return raced;
    throw new Error("checkout identity file exists but is unreadable");
  }
}

export async function loadRecord(folder: EngineFolder): Promise<DeadlineRecord> {
  let text: string;
  try {
    text = await readFile(folder.recordFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyRecord();
    throw error;
  }
  let value: unknown;
  let damaged = false;
  try {
    value = JSON.parse(text);
  } catch {
    damaged = true;
  }
  const parsed = damaged ? null : parseRecord(value);
  if (parsed) return parsed;
  // An older schema or a damaged record: keep it aside and convert it without losing its oldest edit
  // time or treating anything in it as saved (deadline.ts, convertedRecord).
  const info = await stat(folder.recordFile);
  const aside = `${folder.recordFile}.${damaged ? "damaged" : "converted"}-${Date.now()}`;
  await rename(folder.recordFile, aside);
  const converted = convertedRecord(damaged ? undefined : value, info.mtimeMs, Date.now());
  await saveRecord(folder, converted);
  return converted;
}

export async function saveRecord(folder: EngineFolder, record: DeadlineRecord): Promise<void> {
  await writeJsonAtomic(folder.recordFile, record);
}

/** Writes JSON to a temporary file, syncs it and renames it over `path`. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
}

export interface LockOptions {
  waitMs: number;
  /**
   * Hears a failure to remove one of this contender's own files, which then stays and keeps the lock held
   * until this process is gone: its ticket, which the lock otherwise suppresses, or, while acquiring, its
   * choosing announcement. With a listener, a failed withdrawal of the announcement also removes the ticket
   * already taken (a failure to is reported too), and an earlier acquisition error is thrown in place of the
   * withdrawal error. A rejected exclusive creation of this contender's own file, other than `EEXIST`, may
   * have come after the file was created (a failed write or close), so it is reported too: the file may be
   * left. Nothing is removed on that account. Opt-in; a throwing listener is ignored.
   */
  onReleaseError?: (error: unknown) => void;
}

/**
 * Test seams: `beforeRemoveDead` runs before a dead contender's file is removed; `beforeWithdraw` runs after
 * this contender's ticket was taken, before its choosing announcement is withdrawn; `createFile` replaces the
 * exclusive creation of this contender's choosing and ticket files.
 */
export const lockTestHooks: {
  beforeRemoveDead?: (name: string) => Promise<void> | void;
  beforeWithdraw?: (lockDir: string) => Promise<void> | void;
  createFile?: (path: string) => Promise<void>;
} = {};

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const CONTENDER = /^(choosing|ticket)-(?:(\d{12})-)?(\d+)-([0-9a-f]{12})$/;

interface Contender {
  name: string;
  kind: "choosing" | "ticket";
  number: number;
  pid: number;
  id: string;
}

function parseContender(name: string): Contender | null {
  const m = CONTENDER.exec(name);
  if (!m) return null;
  const kind = m[1] as Contender["kind"];
  if ((kind === "ticket") !== (m[2] !== undefined)) return null;
  return { name, kind, number: m[2] ? Number(m[2]) : 0, pid: Number(m[3]), id: `${m[3]}-${m[4]}` };
}

const exclusive = (path: string) => writeFile(path, "", { flag: "wx" });

const before = (a: Contender, b: Contender) => a.number < b.number || (a.number === b.number && a.id < b.id);

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Cross-process operation lock: Lamport's bakery algorithm over files in the lock folder.
 *
 * Each contender announces itself with `choosing-<pid>-<id>`, takes `ticket-<n>-<pid>-<id>` with n one
 * above every ticket it saw, withdraws the announcement, then waits until no live contender is still
 * choosing and no live ticket orders before its own. Every file name is unique to one contender, so
 * removing a dead contender's file can never remove another contender's file: a stale lock is reclaimed
 * by deleting exactly the dead owner's ticket. Liveness is the owner pid; a reused pid looks alive, and
 * the waiter then times out rather than entering.
 */
export async function withFolderLock<T>(lockDir: string, options: LockOptions, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + options.waitMs;
  const id = `${process.pid}-${randomBytes(6).toString("hex")}`;
  await mkdir(lockDir, { recursive: true });
  const releaseFailed = (error: unknown) => {
    try {
      options.onReleaseError?.(error);
    } catch {
      // Reporting cannot change the lock's own outcome.
    }
  };
  // A rejection other than EEXIST does not show the file is absent, so with a listener the claim is reported
  // as possibly left. EEXIST means this attempt created nothing, and the file there is never removed. Without
  // a listener the creation's own promise is awaited, as before.
  const create = (path: string): Promise<void> => {
    const made = (lockTestHooks.createFile ?? exclusive)(path);
    if (!options.onReleaseError) return made;
    return made.catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException | null)?.code !== "EEXIST") {
        releaseFailed(new Error(`${basename(path)} may be left: its creation did not complete: ${String((error as Error | null)?.message ?? error)}`, { cause: error }));
      }
      throw error;
    });
  };
  const choosing = join(lockDir, `choosing-${id}`);
  await create(choosing);
  // Set once this contender's ticket creation completed.
  let mine: Contender | null = null;
  let failure: { error: unknown } | null = null;
  try {
    let highest = 0;
    for (const name of await readdir(lockDir)) {
      const c = parseContender(name);
      if (c?.kind === "ticket") highest = Math.max(highest, c.number);
    }
    const name = `ticket-${String(highest + 1).padStart(12, "0")}-${id}`;
    await create(join(lockDir, name));
    mine = parseContender(name)!;
    const hook = lockTestHooks.beforeWithdraw;
    if (hook) await hook(lockDir);
  } catch (error) {
    failure = { error };
  }
  try {
    await removeIfPresent(choosing);
  } catch (error) {
    // Without a listener the withdrawal error replaces any other and a ticket taken stays, as before.
    if (!options.onReleaseError) throw error;
    releaseFailed(error);
    if (mine) await removeIfPresent(join(lockDir, mine.name)).catch(releaseFailed);
    throw failure ? failure.error : error;
  }
  if (!mine) throw failure!.error;
  if (failure) {
    // Only the test seam can fail once the ticket exists: the ticket is withdrawn and the seam's error thrown.
    await removeIfPresent(join(lockDir, mine.name)).catch(releaseFailed);
    throw failure.error;
  }
  const ticket = join(lockDir, mine.name);
  try {
    for (;;) {
      let waiting = false;
      for (const name of await readdir(lockDir)) {
        const other = parseContender(name);
        if (!other || other.id === mine.id) continue;
        if (other.kind === "ticket" && !before(other, mine)) continue;
        if (alive(other.pid)) {
          waiting = true;
          continue;
        }
        await lockTestHooks.beforeRemoveDead?.(name);
        await removeIfPresent(join(lockDir, name));
      }
      if (!waiting) break;
      if (Date.now() > deadline) throw new Error("another backup operation holds this checkout's lock");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } catch (error) {
    await removeIfPresent(ticket).catch(releaseFailed);
    throw error;
  }
  try {
    return await fn();
  } finally {
    await removeIfPresent(ticket).catch(releaseFailed);
  }
}
