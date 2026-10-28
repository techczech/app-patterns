/**
 * Helper configuration: the explicit list of vaults the helper may back up. Nothing else is discovered.
 *
 * The file is read once at start. It must be a regular file owned by the user running the helper and
 * not writable by group or others, because it decides which folders the helper writes Git objects into.
 * Registration here does not enable backup: each vault also needs the engine's own per-vault enablement
 * record, made by a separate explicit `enable`. The helper never calls `enable` itself.
 *
 * Version 2 adds what a packaged helper needs instead of anything from the user's shell: the absolute
 * paths of the Git and gitleaks programs it may run (`tools`), the one credential helper Git may use for
 * HTTPS (`credentialHelper`), and, per vault, the GitHub repository its remote must be (`github`). Version
 * 1 files keep their exact meaning and may not carry these fields.
 *
 * A version 2 vault may also name a required `history` projection (projection.ts): a capability name,
 * never a module path or command. Only a helper entry built with that projection may serve the vault;
 * the generic helper refuses it (cli.ts), so required history is never silently left out.
 */
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { validateId } from "../backup-ref.ts";
import { compileScope, type BackupScope } from "../scope.ts";
import { isVaultId } from "./protocol.ts";

export const CONFIG_VERSION = 1;
/** The version with trusted tools, credential helper and GitHub identities (production.ts). */
export const CONFIG_VERSION_TOOLS = 2;
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
  /** Version 2: the GitHub repository (`owner/name`) the remote must be; its visibility is checked before each push. */
  github?: { repository: string };
  /** Version 2: the name of the history projection this vault requires (cli.ts HelperExtensions). */
  history?: string;
}

export interface HelperTools {
  /** Absolute path of the Git program. */
  git: string;
  /** Absolute path of the gitleaks program. */
  gitleaks: string;
}

export interface HelperConfig {
  machineId: string;
  /** Capture cadence for every vault, anchored at helper start. Default 60 000 ms. */
  captureIntervalMs: number;
  vaults: RegisteredVault[];
  /** Version 2 only; checked when the file is loaded (tools.ts). */
  tools?: HelperTools;
  /** Version 2: the one `credential.helper` Git may run for HTTPS: "osxkeychain" or an absolute path. */
  credentialHelper?: string;
}

const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** GitHub's owner and repository name rules, conservatively: no dots-only names, no ".git" suffix. */
export const GITHUB_REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.+$)[A-Za-z0-9._-]{1,100}$/;
const NAMED_CREDENTIAL_HELPERS = new Set(["osxkeychain"]);
/** A capability name: lower-case letters, digits and "-". */
export const PROJECTION_NAME = /^[a-z][a-z0-9-]{1,63}$/;

function plainAbsolute(value: unknown, where: string): string {
  if (typeof value !== "string" || value.includes("\0") || !isAbsolute(value) || value.split("/").some((s) => s === "." || s === "..")) throw new Error(`${where} must be a plain absolute path`);
  return value;
}

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
  const v2 = v.configVersion === CONFIG_VERSION_TOOLS;
  only(v, v2 ? ["configVersion", "machineId", "captureIntervalMs", "vaults", "tools", "credentialHelper"] : ["configVersion", "machineId", "captureIntervalMs", "vaults"], "configuration");
  if (v.configVersion !== CONFIG_VERSION && !v2) throw new Error(`configVersion must be ${CONFIG_VERSION} or ${CONFIG_VERSION_TOOLS}`);
  let tools: HelperTools | undefined;
  let credentialHelper: string | undefined;
  if (v2) {
    const t = v.tools;
    if (!t || typeof t !== "object" || Array.isArray(t)) throw new Error("tools must name the git and gitleaks programs");
    only(t as Record<string, unknown>, ["git", "gitleaks"], "tools");
    tools = { git: plainAbsolute((t as Record<string, unknown>).git, "tools.git"), gitleaks: plainAbsolute((t as Record<string, unknown>).gitleaks, "tools.gitleaks") };
    if (v.credentialHelper !== undefined) {
      const c = v.credentialHelper;
      // Git runs an absolute helper through the shell: only plain path characters (tools.ts HELPER_PATH).
      if (typeof c !== "string" || !(NAMED_CREDENTIAL_HELPERS.has(c) || (isAbsolute(c) && plainAbsolute(c, "credentialHelper") === c && /^\/[A-Za-z0-9._+\/-]+$/.test(c)))) {
        throw new Error("credentialHelper must be \"osxkeychain\" or a plain absolute path of letters, digits and . _ + - /");
      }
      credentialHelper = c;
    }
  }
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
    only(e, v2 ? ["id", "path", "include", "exclude", "remote", "github", "history"] : ["id", "path", "include", "exclude", "remote"], where);
    if (!isVaultId(e.id)) throw new Error(`${where}.id must be 1-64 letters, digits, '.', '_' or '-'`);
    if (ids.has(e.id)) throw new Error(`${where}.id repeats ${e.id}`);
    if (typeof e.path !== "string" || e.path.includes("\0") || !isAbsolute(e.path)) throw new Error(`${where}.path must be an absolute path`);
    const real = await realpath(e.path);
    if (paths.has(real)) throw new Error(`${where}.path registers the same folder twice`);
    const scope: BackupScope = { include: strings(e.include, `${where}.include`), exclude: e.exclude === undefined ? [] : strings(e.exclude, `${where}.exclude`) };
    compileScope(scope);
    const remote = e.remote === undefined ? "origin" : e.remote;
    if (typeof remote !== "string" || !REMOTE_NAME.test(remote)) throw new Error(`${where}.remote must be a configured remote name`);
    let github: RegisteredVault["github"];
    if (e.github !== undefined) {
      const g = e.github as Record<string, unknown> | null;
      if (!g || typeof g !== "object" || Array.isArray(g)) throw new Error(`${where}.github must be an object`);
      only(g, ["repository"], `${where}.github`);
      if (typeof g.repository !== "string" || !GITHUB_REPOSITORY.test(g.repository) || g.repository.toLowerCase().endsWith(".git")) throw new Error(`${where}.github.repository must be owner/name`);
      github = { repository: g.repository };
    }
    if (e.history !== undefined && (typeof e.history !== "string" || !PROJECTION_NAME.test(e.history))) throw new Error(`${where}.history must name a history projection (lower-case letters, digits and -)`);
    ids.add(e.id);
    paths.add(real);
    vaults.push({ id: e.id, path: real, scope, remote, ...(github ? { github } : {}), ...(typeof e.history === "string" ? { history: e.history } : {}) });
  }
  return { machineId, captureIntervalMs, vaults, ...(tools ? { tools } : {}), ...(credentialHelper ? { credentialHelper } : {}) };
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
