/**
 * Helper configuration: the explicit list of vaults the helper may back up. Nothing else is discovered.
 *
 * The file is read once at start. It must be a regular file owned by the user running the helper and
 * not writable by group or others, because it decides which folders the helper writes Git objects into.
 * Registration here does not enable backup: each vault also needs the engine's own per-vault enablement
 * record, made by a separate explicit `enable`. The helper never calls `enable` itself.
 */
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { validateId } from "../backup-ref.ts";
import { compileScope, type BackupScope } from "../scope.ts";
import { isVaultId } from "./protocol.ts";

export const CONFIG_VERSION = 1;
export const MAX_VAULTS = 32;
export const MIN_CAPTURE_INTERVAL_MS = 1_000;
export const MAX_CAPTURE_INTERVAL_MS = 60 * 60_000;

export interface RegisteredVault {
  id: string;
  /** Real path of the worktree, resolved when the configuration was loaded. */
  path: string;
  scope: BackupScope;
  /** Configured remote name. Default "origin". */
  remote: string;
}

export interface HelperConfig {
  machineId: string;
  /** Capture cadence for every vault, anchored at helper start. Default 60 000 ms. */
  captureIntervalMs: number;
  vaults: RegisteredVault[];
}

const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function only(value: Record<string, unknown>, keys: string[], where: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${where}: unexpected field ${JSON.stringify(key).slice(0, 40)}`);
}

function strings(value: unknown, where: string): string[] {
  if (!Array.isArray(value) || value.some((s) => typeof s !== "string" || s === "" || s.includes("\0"))) throw new Error(`${where} must be a list of non-empty strings`);
  return [...value] as string[];
}

/** Validates a parsed configuration. Paths are resolved to real paths; two entries for one folder are refused. */
export async function parseHelperConfig(value: unknown): Promise<HelperConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("configuration must be a JSON object");
  const v = value as Record<string, unknown>;
  only(v, ["configVersion", "machineId", "captureIntervalMs", "vaults"], "configuration");
  if (v.configVersion !== CONFIG_VERSION) throw new Error(`configVersion must be ${CONFIG_VERSION}`);
  const machineId = validateId("machineId", v.machineId as string);
  const captureIntervalMs = v.captureIntervalMs === undefined ? 60_000 : (v.captureIntervalMs as number);
  if (!Number.isSafeInteger(captureIntervalMs) || captureIntervalMs < MIN_CAPTURE_INTERVAL_MS || captureIntervalMs > MAX_CAPTURE_INTERVAL_MS) {
    throw new Error(`captureIntervalMs must be an integer from ${MIN_CAPTURE_INTERVAL_MS} to ${MAX_CAPTURE_INTERVAL_MS}`);
  }
  if (!Array.isArray(v.vaults) || v.vaults.length === 0 || v.vaults.length > MAX_VAULTS) throw new Error(`vaults must list 1 to ${MAX_VAULTS} registered vaults`);
  const vaults: RegisteredVault[] = [];
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const [index, entry] of v.vaults.entries()) {
    const where = `vaults[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${where} must be an object`);
    const e = entry as Record<string, unknown>;
    only(e, ["id", "path", "include", "exclude", "remote"], where);
    if (!isVaultId(e.id)) throw new Error(`${where}.id must be 1-64 letters, digits, '.', '_' or '-'`);
    if (ids.has(e.id)) throw new Error(`${where}.id repeats ${e.id}`);
    if (typeof e.path !== "string" || e.path.includes("\0") || !isAbsolute(e.path)) throw new Error(`${where}.path must be an absolute path`);
    const real = await realpath(e.path);
    if (paths.has(real)) throw new Error(`${where}.path registers the same folder twice`);
    const scope: BackupScope = { include: strings(e.include, `${where}.include`), exclude: e.exclude === undefined ? [] : strings(e.exclude, `${where}.exclude`) };
    compileScope(scope);
    const remote = e.remote === undefined ? "origin" : e.remote;
    if (typeof remote !== "string" || !REMOTE_NAME.test(remote)) throw new Error(`${where}.remote must be a configured remote name`);
    ids.add(e.id);
    paths.add(real);
    vaults.push({ id: e.id, path: real, scope, remote });
  }
  return { machineId, captureIntervalMs, vaults };
}

/** Reads and validates the configuration file, refusing one that another user could have changed. */
export async function loadHelperConfig(file: string, uid: number | undefined = process.getuid?.()): Promise<HelperConfig> {
  if (!isAbsolute(file)) throw new Error("configuration path must be absolute");
  const info = await lstat(file);
  if (!info.isFile()) throw new Error("configuration must be a regular file, not a link or folder");
  if (uid !== undefined && info.uid !== uid) throw new Error("configuration must be owned by the user running the helper");
  if ((info.mode & 0o022) !== 0) throw new Error("configuration must not be writable by group or others");
  if (info.size > 256 * 1024) throw new Error("configuration is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new Error("configuration is not valid JSON");
  }
  return parseHelperConfig(parsed);
}
