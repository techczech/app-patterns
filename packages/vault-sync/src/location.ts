/**
 * Cloud-synced and network locations. A Git worktree inside a folder that a sync client also writes
 * (OneDrive, iCloud Drive, Dropbox, Google Drive) or on a network share can be corrupted by the two
 * writers, so the engine refuses to work there.
 *
 * Two checks:
 * - `isCloudSyncedLocation` is pure: it decides from the real path, the home directory, the platform and
 *   (on Windows) the OneDrive environment variables.
 * - `mountInfo` reads the mount table to find network file systems. On macOS it parses `/sbin/mount`
 *   output and treats a mount as network when its type is a known network type or its flags lack
 *   `local` (the MNT_LOCAL flag); on Linux it reads `/proc/self/mounts`. Other platforms report nothing.
 *   File Provider folders on macOS are covered by the `Library/CloudStorage` path rule, not by mounts.
 *
 * Paths are compared without regard to case: macOS and Windows volumes are usually case-insensitive,
 * and refusing a differently-cased look-alike folder errs on the safe side.
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { posix, win32 } from "node:path";

export interface LocationEnvironment {
  homeDir: string;
  platform: NodeJS.Platform;
  /** Environment variables; only the OneDrive ones are read, and only on Windows. */
  env?: Record<string, string | undefined>;
}

export type CloudLocationKind = "cloud-storage" | "icloud-drive" | "home-sync-folder" | "onedrive-folder" | "network-mount";

export type CloudLocation = { cloud: false } | { cloud: true; kind: CloudLocationKind; root: string };

const ONEDRIVE_ENV = ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"];
const HOME_SYNC_EXACT = new Set(["dropbox", "google drive"]);

function pathApi(platform: NodeJS.Platform) {
  return platform === "win32" ? win32 : posix;
}

/** True when `child` is `parent` or lies below it (case-insensitive, after normalising). */
function within(api: typeof posix, parent: string, child: string): boolean {
  const p = api.resolve(parent).toLowerCase();
  const c = api.resolve(child).toLowerCase();
  if (c === p) return true;
  const withSep = p.endsWith(api.sep) ? p : p + api.sep;
  return c.startsWith(withSep);
}

export function isCloudSyncedLocation(realPath: string, environment: LocationEnvironment): CloudLocation {
  const api = pathApi(environment.platform);
  const home = environment.homeDir;
  const cloudStorage = api.join(home, "Library", "CloudStorage");
  if (within(api, cloudStorage, realPath)) return { cloud: true, kind: "cloud-storage", root: cloudStorage };
  const icloud = api.join(home, "Library", "Mobile Documents");
  if (within(api, icloud, realPath)) return { cloud: true, kind: "icloud-drive", root: icloud };
  if (within(api, home, realPath)) {
    // Any folder below home, at any depth: sync clients let the user place their folder anywhere.
    const segments = api.relative(api.resolve(home), api.resolve(realPath)).split(api.sep).filter(Boolean);
    for (const [index, segment] of segments.entries()) {
      const name = segment.toLowerCase();
      if (name.startsWith("onedrive") || HOME_SYNC_EXACT.has(name)) return { cloud: true, kind: "home-sync-folder", root: api.join(home, ...segments.slice(0, index + 1)) };
    }
  }
  if (environment.platform === "win32") {
    for (const key of ONEDRIVE_ENV) {
      const value = lookupEnv(environment.env, key);
      if (value && api.isAbsolute(value) && within(api, value, realPath)) return { cloud: true, kind: "onedrive-folder", root: value };
    }
  }
  return { cloud: false };
}

/** Windows environment names are case-insensitive. */
function lookupEnv(env: Record<string, string | undefined> | undefined, key: string): string | undefined {
  if (!env) return undefined;
  if (env[key]) return env[key];
  const lower = key.toLowerCase();
  for (const [name, value] of Object.entries(env)) if (name.toLowerCase() === lower && value) return value;
  return undefined;
}

export interface MountEntry {
  mountPoint: string;
  type: string;
  /** macOS only: whether the flags include `local`. Null where the table does not say. */
  local: boolean | null;
}

export const NETWORK_FILESYSTEM_TYPES: ReadonlySet<string> = new Set([
  "smbfs", "afpfs", "nfs", "nfs4", "webdav", "cifs", "smb3", "smb2", "ftp", "davfs", "fuse.davfs2",
  "sshfs", "fuse.sshfs", "fuse.rclone", "9p", "macfuse", "osxfuse", "fuse.s3fs", "ncpfs", "afs",
]);

export function isNetworkMount(entry: MountEntry): boolean {
  return NETWORK_FILESYSTEM_TYPES.has(entry.type.toLowerCase()) || entry.local === false;
}

/** Parses `/sbin/mount` (macOS) or `/proc/self/mounts` (Linux) text. Unparseable lines are skipped. */
export function parseMountTable(text: string, platform: NodeJS.Platform): MountEntry[] {
  const entries: MountEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    if (platform === "darwin") {
      // "<device> on <mount point> (<type>, <flag>, ...)"; the mount point may contain spaces.
      const match = /^(.+?) on (.+) \(([^()]*)\)$/.exec(line);
      if (!match) continue;
      const flags = match[3]!.split(",").map((f) => f.trim());
      const type = flags.shift() ?? "";
      entries.push({ mountPoint: match[2]!, type, local: flags.includes("local") });
    } else {
      // "<device> <mount point> <type> <options> 0 0", with spaces escaped as octal (\040).
      const fields = line.split(" ");
      if (fields.length < 3) continue;
      const decode = (s: string) => s.replace(/\\([0-7]{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)));
      entries.push({ mountPoint: decode(fields[1]!), type: fields[2]!, local: null });
    }
  }
  return entries;
}

/** The mount whose mount point is the longest prefix of the path. */
export function mountFor(realPath: string, entries: readonly MountEntry[]): MountEntry | null {
  let best: MountEntry | null = null;
  for (const entry of entries) {
    const point = entry.mountPoint;
    const under = realPath === point || point === "/" || realPath.startsWith(point.endsWith("/") ? point : `${point}/`);
    if (under && (!best || point.length > best.mountPoint.length)) best = entry;
  }
  return best;
}

export type MountInfoReader = (realPath: string) => Promise<MountEntry | null>;

/**
 * Default mount reader. It throws when the table cannot be read on macOS or Linux, which the engine
 * treats as a refusal (fail closed). Other platforms have no mount rule and report null.
 */
export function defaultMountInfo(platform: NodeJS.Platform): MountInfoReader {
  return async (realPath) => {
    let text: string;
    if (platform === "darwin") {
      text = await new Promise<string>((resolve, reject) => {
        execFile("/sbin/mount", [], { timeout: 5000, maxBuffer: 1024 * 1024, env: { LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
      });
    } else if (platform === "linux") {
      text = await readFile("/proc/self/mounts", "utf8");
    } else {
      return null;
    }
    return mountFor(realPath, parseMountTable(text, platform));
  };
}
