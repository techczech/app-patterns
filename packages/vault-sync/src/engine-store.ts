/**
 * The engine's private folder inside a checkout's git directory: checkout identity, the deadline
 * record, the private index, an empty hooks directory and an operation lock shared by every
 * engine process on this machine. Nothing here is inside the worktree.
 */
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { emptyRecord, parseRecord, type DeadlineRecord } from "./deadline.ts";

export const ENGINE_FOLDER = "vault-sync";

export interface EngineFolder {
  dir: string;
  indexFile: string;
  hooksDir: string;
  recordFile: string;
  checkoutFile: string;
  lockFile: string;
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
    lockFile: join(dir, "operation.lock"),
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
  let parsed: DeadlineRecord | null = null;
  try {
    parsed = parseRecord(JSON.parse(text));
  } catch {
    parsed = null;
  }
  if (parsed) return { ...emptyRecord(), ...parsed };
  // Damaged record: keep it aside and assume work has been unprotected since its last write.
  const info = await stat(folder.recordFile);
  const aside = `${folder.recordFile}.damaged-${Date.now()}`;
  await rename(folder.recordFile, aside);
  const recovered: DeadlineRecord = { ...emptyRecord(), oldestUnprotectedEdit: Math.min(info.mtimeMs, Date.now()), recoveredFromDamagedRecord: true };
  await saveRecord(folder, recovered);
  return recovered;
}

export async function saveRecord(folder: EngineFolder, record: DeadlineRecord): Promise<void> {
  const tmp = `${folder.recordFile}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, folder.recordFile);
}

export interface LockOptions {
  waitMs: number;
  /** A lock file without a readable owner pid is taken over once it is this old. */
  staleMs: number;
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Cross-process operation lock: exclusive-create file holding the owner's pid. */
export async function withFolderLock<T>(folder: EngineFolder, options: LockOptions, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + options.waitMs;
  const token = `${process.pid}:${randomBytes(6).toString("hex")}`;
  for (;;) {
    try {
      await writeFile(folder.lockFile, `${token}\n`, { flag: "wx" });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner = "";
      let age = 0;
      try {
        owner = (await readFile(folder.lockFile, "utf8")).trim();
        age = Date.now() - (await stat(folder.lockFile)).mtimeMs;
      } catch {
        continue;
      }
      const pid = Number(owner.split(":")[0]);
      const ownerIsThisProcess = pid === process.pid;
      const ownerUnknown = !Number.isInteger(pid) || pid <= 0;
      if ((!ownerUnknown && !ownerIsThisProcess && !alive(pid)) || (ownerUnknown && age > options.staleMs)) {
        await rm(folder.lockFile, { force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error("another backup operation holds this checkout's lock");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      const current = (await readFile(folder.lockFile, "utf8")).trim();
      if (current === token) await rm(folder.lockFile, { force: true });
    } catch { /* already gone */ }
  }
}
