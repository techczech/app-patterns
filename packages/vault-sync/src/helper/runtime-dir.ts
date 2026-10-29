/**
 * The helper's private runtime folder: owner lock and socket.
 *
 * The folder is the access boundary for the socket. It must be a real folder (not a link) owned by the
 * user running the helper with no group or other permissions; the helper creates it with mode 0700 when
 * it is missing but never loosens, tightens or takes over an existing folder that fails these checks.
 * Node offers no peer-credential check on Unix sockets, so this folder's permissions are what keep other
 * users out.
 *
 * Path authority: the folder is named by a plain absolute path (no "." or ".." segments) and resolved to
 * its real path. The checks, the socket, the owner lock, stale-socket removal and the client all use that
 * one real path, and the named folder and the real folder must be the same object (device and inode), so
 * no lexical rewrite can make the helper check one folder and write into another. The parents of the real
 * folder are trusted as they are: someone who can rename a parent can move the folder, which
 * `assertSameFolder` notices at each later use but cannot prevent.
 *
 * One helper owns a runtime folder at a time, through the engine's cross-process folder lock held for the
 * helper's whole life. A live owner is never displaced; a dead owner's lock is reclaimed by that lock's own
 * rules. The socket file is removed only when it is a socket and the folder's owner lock is held by this
 * process, and on shutdown only if it is still the socket this process created.
 */
import type { Stats } from "node:fs";
import { lstat, mkdir, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export const SOCKET_NAME = "helper.sock";
export const OWNER_LOCK_NAME = "owner.lock";
/** sun_path is 104 bytes on macOS, including the terminating NUL. */
export const MAX_SOCKET_PATH_BYTES = 103;

export interface RuntimePaths {
  /** Real path of the checked folder. */
  dir: string;
  socket: string;
  ownerLock: string;
  /** Device and inode of the checked folder. */
  identity: { dev: number; ino: number };
}

/** Refuses anything but a plain absolute path, so the path names one folder before the filesystem resolves it. */
export function plainAbsolutePath(dir: string, what = "runtime folder"): string {
  if (typeof dir !== "string" || !isAbsolute(dir) || dir.includes("\0")) throw new Error(`${what} must be an absolute path`);
  if (dir.split("/").some((segment) => segment === "." || segment === "..")) throw new Error(`${what} must not contain '.' or '..' segments`);
  return dir;
}

/** Names the socket of a runtime folder without touching the filesystem; `connectHelper` resolves it before use. */
export function runtimeSocketPath(dir: string): string {
  return join(plainAbsolutePath(dir), SOCKET_NAME);
}

function assertPrivate(info: Stats, uid: number | undefined): void {
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("runtime folder must be a folder, not a link");
  if (uid !== undefined && info.uid !== uid) throw new Error("runtime folder must be owned by the user running the helper");
  if ((info.mode & 0o077) !== 0) throw new Error("runtime folder must not be accessible to group or others (mode 0700)");
}

/** Checks that `dir` is a private folder of `uid`. Throws with a plain reason otherwise. */
export async function checkPrivateFolder(dir: string, uid: number | undefined = process.getuid?.()): Promise<void> {
  assertPrivate(await lstat(plainAbsolutePath(dir)), uid);
}

/**
 * Resolves an existing runtime folder to its real path and checks it. Every operational path is derived
 * from the real path, and the named and the real folder must be one object. `socketName` names the socket
 * whose path length is checked (the helper's own, or the one a client was given).
 */
export async function resolveRuntimeFolder(dir: string, uid: number | undefined = process.getuid?.(), socketName = SOCKET_NAME): Promise<RuntimePaths> {
  const named = await lstat(plainAbsolutePath(dir));
  assertPrivate(named, uid);
  const real = await realpath(dir);
  const info = await lstat(real);
  if (info.dev !== named.dev || info.ino !== named.ino) throw new Error("runtime folder changed while it was being checked");
  assertPrivate(info, uid);
  const socket = join(real, socketName);
  if (Buffer.byteLength(socket) > MAX_SOCKET_PATH_BYTES) throw new Error(`socket path is longer than ${MAX_SOCKET_PATH_BYTES} bytes; choose a shorter runtime folder`);
  return { dir: real, socket, ownerLock: join(real, OWNER_LOCK_NAME), identity: { dev: info.dev, ino: info.ino } };
}

/** Creates the runtime folder (parent must exist) or checks the existing one, then resolves it. */
export async function prepareRuntimeFolder(dir: string): Promise<RuntimePaths> {
  try {
    await mkdir(plainAbsolutePath(dir), { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return resolveRuntimeFolder(dir);
}

/** Throws unless the real folder is still the checked object and still private. */
export async function assertSameFolder(paths: RuntimePaths, uid: number | undefined = process.getuid?.()): Promise<void> {
  const info = await lstat(paths.dir);
  if (info.dev !== paths.identity.dev || info.ino !== paths.identity.ino) throw new Error("runtime folder was replaced while the helper was using it");
  assertPrivate(info, uid);
}

/** Removes a leftover socket file of a dead owner. Call only while holding the owner lock. */
export async function removeStaleSocket(paths: RuntimePaths): Promise<void> {
  await assertSameFolder(paths);
  let info;
  try {
    info = await lstat(paths.socket);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!info.isSocket()) throw new Error("runtime folder holds a non-socket file where the socket belongs; it was left in place");
  await unlink(paths.socket);
}

/**
 * What became of this process's socket on shutdown. "removed": it was unlinked. "absent": nothing is at the
 * path. "replaced": another file is there now; it is not this process's and was left in place.
 */
export type OwnSocketRemoval = "removed" | "absent" | "replaced";

const missing = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code === "ENOENT";

/**
 * Removes the socket on shutdown only if it is still the one this process created (same device and inode).
 * Rejects when the path could not be checked or the socket could not be removed: that is a failure, not
 * an absent or replaced socket.
 */
export async function removeOwnSocket(socket: string, own: { dev: number; ino: number }): Promise<OwnSocketRemoval> {
  let info;
  try {
    info = await lstat(socket);
  } catch (error) {
    if (missing(error)) return "absent";
    throw error;
  }
  if (!info.isSocket() || info.dev !== own.dev || info.ino !== own.ino) return "replaced";
  try {
    await unlink(socket);
  } catch (error) {
    if (missing(error)) return "absent";
    throw error;
  }
  return "removed";
}
