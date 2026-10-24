/**
 * Stable reads: a file is captured only when the bytes read belong to one settled version.
 *
 * Each attempt stats the path, reads through one descriptor, re-stats the descriptor and the path, and
 * accepts the bytes only if size, mtime, ctime, inode and device are unchanged and the last change is at
 * least `settleMs` old. A writer that truncates and then writes therefore yields either the old or the new
 * full content, or (after the bounded retries) a "pending" outcome. A writer that leaves a file truncated
 * for longer than `settleMs` cannot be told apart from a deliberately emptied file; writers should replace
 * files atomically.
 *
 * Containment: when `root` is given, the path must lie inside it with every intermediate component a
 * real directory (never a symlink), checked before each attempt, and after the file is opened the real
 * path of its directory must still be the worktree's own. A path that fails is reported as
 * "beyond-symlink" and its bytes are never returned. Leaf symlinks are read with readlink, never followed;
 * regular files are opened with O_NOFOLLOW where the platform has it.
 */
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

export type GitFileMode = "100644" | "100755" | "120000";

export type StableRead =
  | { ok: true; mode: GitFileMode; content: Buffer; key: string; changedAtMs: number }
  | { ok: false; reason: "missing" | "unstable" | "too-large" | "unreadable" | "beyond-symlink" };

export interface StableReadOptions {
  settleMs: number;
  retries: number;
  maxFileBytes: number;
  /** Wall clock used to judge whether the last change has settled (file times are wall-clock). */
  wallNow?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Real path of the worktree root. When set, reads are confined to it (see Containment above). */
  root?: string;
  /** Test seam: runs after the containment check and before the file is examined, on every attempt. */
  afterContainmentCheck?: () => Promise<void> | void;
}

const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

export type Containment = "ok" | "missing" | "beyond-symlink";

/**
 * Checks that `path` lies inside `root` (a real path) and that every intermediate component is a real
 * directory. lstat on the full path would follow symlinks in intermediate components, so each prefix is
 * lstat-ed on its own. The final component is not examined.
 */
export async function checkContainment(root: string, path: string): Promise<Containment> {
  const rel = relative(root, path);
  if (rel === "" || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return "beyond-symlink";
  const parts = rel.split(sep);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    let info;
    try {
      info = await lstat(current);
    } catch {
      return "missing";
    }
    if (info.isSymbolicLink()) return "beyond-symlink";
    if (!info.isDirectory()) return "missing";
  }
  return "ok";
}

/** After a file is opened: its directory's real path must be the root's own, not reached through a link. */
async function directoryStillInside(root: string, path: string): Promise<boolean> {
  try {
    return (await realpath(dirname(path))) === join(root, dirname(relative(root, path)));
  } catch {
    return false;
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function statKey(s: BigIntStats): string {
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.mode}`;
}

function changedAtMs(s: BigIntStats): number {
  const m = Number(s.mtimeNs / 1_000_000n);
  const c = Number(s.ctimeNs / 1_000_000n);
  return Math.max(m, c);
}

function modeOf(s: BigIntStats): GitFileMode {
  if (s.isSymbolicLink()) return "120000";
  return (Number(s.mode) & 0o111) !== 0 && process.platform !== "win32" ? "100755" : "100644";
}

type Attempt =
  | { kind: "ok"; mode: GitFileMode; content: Buffer; key: string; changedAtMs: number }
  | { kind: "changed" }
  | { kind: "missing" }
  | { kind: "too-large" }
  | { kind: "unreadable" }
  | { kind: "beyond-symlink" };

async function attempt(path: string, options: StableReadOptions): Promise<Attempt> {
  const { maxFileBytes, root } = options;
  if (root !== undefined) {
    const contained = await checkContainment(root, path);
    if (contained !== "ok") return { kind: contained };
  }
  await options.afterContainmentCheck?.();
  let before: BigIntStats;
  try {
    before = await lstat(path, { bigint: true });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "unreadable" };
  }
  if (before.isSymbolicLink()) {
    let target: string;
    try {
      target = await readlink(path);
    } catch {
      return { kind: "changed" };
    }
    let after: BigIntStats;
    try {
      after = await lstat(path, { bigint: true });
    } catch {
      return { kind: "changed" };
    }
    if (statKey(before) !== statKey(after)) return { kind: "changed" };
    if (root !== undefined && !(await directoryStillInside(root, path))) return { kind: "beyond-symlink" };
    return { kind: "ok", mode: "120000", content: Buffer.from(target, "utf8"), key: statKey(after), changedAtMs: changedAtMs(after) };
  }
  if (!before.isFile()) return { kind: "missing" };
  if (before.size > BigInt(maxFileBytes)) return { kind: "too-large" };
  let handle;
  try {
    handle = await open(path, OPEN_FLAGS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ELOOP: the leaf became a symlink after lstat; re-examine it as one on the next attempt.
    if (code === "ELOOP") return { kind: "changed" };
    return code === "ENOENT" ? { kind: "missing" } : { kind: "unreadable" };
  }
  try {
    if (root !== undefined && !(await directoryStillInside(root, path))) return { kind: "beyond-symlink" };
    const opened = await handle.stat({ bigint: true });
    if (statKey(opened) !== statKey(before)) return { kind: "changed" };
    const content = await handle.readFile();
    const closedStat = await handle.stat({ bigint: true });
    if (statKey(closedStat) !== statKey(before) || BigInt(content.length) !== before.size) return { kind: "changed" };
    let after: BigIntStats;
    try {
      after = await lstat(path, { bigint: true });
    } catch {
      return { kind: "changed" };
    }
    if (statKey(after) !== statKey(before)) return { kind: "changed" };
    return { kind: "ok", mode: modeOf(before), content, key: statKey(after), changedAtMs: changedAtMs(after) };
  } catch {
    return { kind: "unreadable" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function readStable(path: string, options: StableReadOptions): Promise<StableRead> {
  const wallNow = options.wallNow ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  for (let i = 0; i <= options.retries; i += 1) {
    const result = await attempt(path, options);
    if (result.kind === "missing" || result.kind === "too-large" || result.kind === "unreadable" || result.kind === "beyond-symlink") return { ok: false, reason: result.kind };
    if (result.kind === "ok") {
      const age = wallNow() - result.changedAtMs;
      // A future timestamp is clock skew, not an ongoing write.
      if (age >= options.settleMs || age < -options.settleMs) {
        return { ok: true, mode: result.mode, content: result.content, key: result.key, changedAtMs: result.changedAtMs };
      }
      if (i < options.retries) await sleep(Math.max(1, options.settleMs - age + 1));
      continue;
    }
    if (i < options.retries) await sleep(Math.max(1, Math.min(options.settleMs, 50)));
  }
  return { ok: false, reason: "unstable" };
}
