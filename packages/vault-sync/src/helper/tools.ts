/**
 * The native programs a production helper runs, named by absolute path in its configuration (config.ts,
 * version 2) and never looked up on PATH.
 *
 * A program is trusted when its real path is a regular, executable file owned by root or by the user
 * running the helper and not writable by group or others, AND every folder above that real path, up to
 * `/`, could not have let anyone else replace it: each is owned by root or the user, and is writable by
 * nobody else, except that
 * - a folder writable by group is accepted only when its group is wheel (0) or, on macOS, admin (80):
 *   members of those groups can already act as root (Homebrew's own folders are admin-writable);
 * - a folder writable by others (or its group) is accepted only with the sticky bit (as /private/tmp):
 *   there nobody can rename or replace an entry they do not own, and the entry below it must itself be
 *   owned by root or the user. A disposable test folder made by the user under the system temporary folder passes this
 *   way; nothing else is relaxed.
 * Someone who could replace the program, or a folder on its way, could run code as this user on every
 * backup cycle. The checked real path is what runs afterwards, never the name it was found under.
 * Its version is read once (`<git> --version`, `<gitleaks> version`, no shell, 5 s) and must be one this
 * engine is written for: Git 2.x from 2.38, gitleaks 8.x (the scanner uses `gitleaks detect --no-git`).
 * Anything else is refused with what was found, so a caller can show it.
 *
 * The credential helper gets the same check (`trustedCredentialHelper`): `osxkeychain` is resolved to
 * `git-credential-osxkeychain` in the trusted Git's own exec path; an absolute helper is checked as it is.
 * Its checked absolute real path is what both the visibility check and the push run.
 */
import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

export interface ToolCheck {
  /** Real path of the program. */
  path: string;
  version: string;
}

export class ToolRefusedError extends Error {
  constructor(readonly tool: "git" | "gitleaks", message: string) {
    super(`${tool}: ${message}`);
    this.name = "ToolRefusedError";
  }
}

/** The environment a version probe runs with: nothing from the user's shell. */
const PROBE_ENV = { LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };

/** Groups whose members can already act as root: wheel, and admin on macOS. */
const PRIVILEGED_GROUPS = new Set(process.platform === "darwin" ? [0, 80] : [0]);
const STICKY = 0o1000;

/** Why the folders above `real` would let someone else replace it; null when none would. */
async function replaceableAncestor(real: string, uid: number | undefined): Promise<string | null> {
  for (let dir = dirname(real); ; dir = dirname(dir)) {
    const info = await lstat(dir);
    if (!info.isDirectory()) return `${dir} is not a folder`;
    if (uid !== undefined && info.uid !== 0 && info.uid !== uid) return `${dir} is owned by another user`;
    // Sticky: nobody can rename or replace an entry they do not own, and the entry below is checked as owned.
    if ((info.mode & STICKY) === 0) {
      if ((info.mode & 0o002) !== 0) return `${dir} is writable by others`;
      if ((info.mode & 0o020) !== 0 && !PRIVILEGED_GROUPS.has(info.gid)) return `${dir} is writable by its group`;
    }
    if (dir === dirname(dir)) return null;
  }
}

/** The real path of `path` when it, and every folder above it, could not have been replaced by another user. */
async function trustedFile(path: string, uid: number | undefined): Promise<{ real: string } | { refused: string }> {
  if (!isAbsolute(path)) return { refused: "the path must be absolute" };
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    return { refused: `not found at ${path}` };
  }
  const info = await lstat(real);
  if (!info.isFile()) return { refused: `${real} is not a regular file` };
  if ((info.mode & 0o111) === 0) return { refused: `${real} is not executable` };
  if ((info.mode & 0o022) !== 0) return { refused: `${real} is writable by group or others` };
  if (uid !== undefined && info.uid !== 0 && info.uid !== uid) return { refused: `${real} is owned by another user` };
  const parent = await replaceableAncestor(real, uid);
  if (parent) return { refused: `${parent}, so ${real} could be replaced` };
  return { real };
}

/** Real path of a trusted program; throws ToolRefusedError naming why it is not trusted. */
export async function trustedExecutable(tool: "git" | "gitleaks", path: string, uid: number | undefined = process.getuid?.()): Promise<string> {
  const checked = await trustedFile(path, uid);
  if ("refused" in checked) throw new ToolRefusedError(tool, checked.refused);
  return checked.real;
}

export class CredentialHelperRefusedError extends Error {
  constructor(message: string) {
    super(`credential helper: ${message}`);
    this.name = "CredentialHelperRefusedError";
  }
}

/** Characters a credential helper path may have: Git runs an absolute helper through the shell. */
const HELPER_PATH = /^\/[A-Za-z0-9._+\/-]+$/;

/**
 * The checked absolute real path of the configured credential helper: `osxkeychain` in the trusted Git's
 * exec path, or the absolute path given. `gitPath` must already be the trusted Git's real path.
 */
export async function trustedCredentialHelper(gitPath: string, helper: string, uid: number | undefined = process.getuid?.()): Promise<string> {
  let candidate = helper;
  if (helper === "osxkeychain") {
    let execPath: string;
    try {
      execPath = (await probe(gitPath, ["--exec-path"])).trim();
    } catch {
      throw new CredentialHelperRefusedError(`${gitPath} did not report its exec path`);
    }
    if (!isAbsolute(execPath) || /[\0\n]/.test(execPath)) throw new CredentialHelperRefusedError("Git reported an unusable exec path");
    candidate = join(execPath, "git-credential-osxkeychain");
  }
  const checked = await trustedFile(candidate, uid);
  if ("refused" in checked) throw new CredentialHelperRefusedError(checked.refused);
  if (!HELPER_PATH.test(checked.real)) throw new CredentialHelperRefusedError(`${checked.real.slice(0, 120)} has characters a helper path may not have`);
  return checked.real;
}

function probe(path: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(path, args, { timeout: 5_000, maxBuffer: 64 * 1024, env: PROBE_ENV }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
  });
}

export function parseGitVersion(text: string): string | null {
  const m = /^git version (\d+)\.(\d+)\.(\d+)/.exec(text.trim());
  if (!m) return null;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major === 2 && minor >= 38 ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

export function parseGitleaksVersion(text: string): string | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)\s*$/.exec(text.trim());
  return m && m[1] === "8" ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/** Checks one program and reads its version. */
export async function checkTool(tool: "git" | "gitleaks", path: string, uid?: number): Promise<ToolCheck> {
  const real = await trustedExecutable(tool, path, uid);
  let out: string;
  try {
    out = await probe(real, tool === "git" ? ["--version"] : ["version"]);
  } catch {
    throw new ToolRefusedError(tool, `${real} did not report its version`);
  }
  const version = tool === "git" ? parseGitVersion(out) : parseGitleaksVersion(out);
  if (!version) throw new ToolRefusedError(tool, `${real} reports an unsupported version (${out.trim().slice(0, 60)}); ${tool === "git" ? "Git 2.38 or later" : "gitleaks 8"} is required`);
  return { path: real, version };
}
