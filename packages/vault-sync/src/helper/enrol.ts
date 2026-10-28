/**
 * One-shot enrolment commands for a production configuration (config.ts version 2): `preview`, `enable`
 * and `disable` of one registered vault. They run in the helper's own process (cli.ts), never in an app,
 * and use the engine and its guards as they are.
 *
 * - preview reads only: the trusted programs and their versions, the vault's real root (the engine refuses
 *   a folder inside a worktree), the cloud-folder and network-drive rules (location.ts, the engine's own),
 *   the remote as the engine validates it (destination.ts), the GitHub repository it is and that
 *   repository's visibility with the reason for an unknown, every path the scope would back up, and what
 *   the backup publishes. It prints paths, never file contents, and never the remote address with any
 *   credential in it.
 * - enable writes the engine's per-vault enablement record only after the tools are trusted and the remote
 *   is private, or public with `confirmPublic`. An unknown visibility (no credential, refused, not found,
 *   network) is refused, so a vault whose repository cannot be checked never starts. The engine itself
 *   refuses cloud and network folders and an unconfirmed public remote again.
 * - disable removes only the enablement record (engine.disable): backup branches, receipts, the record
 *   and any unprotected-edit debt stay where they are.
 * - Destination: preview reports the digest of the validated remote address (enablement.ts urlDigest).
 *   enable takes the digest the user was shown and the engine refuses unless the address it is about to
 *   pin has exactly that digest, for a local folder as for GitHub.
 * - Required history (config.ts `history`): preview reads the vault's projection with the same checks
 *   capture applies (projection.ts checkCohort) and reports its exact paths, count and bytes, or why it is
 *   unavailable. A helper entry without that projection refuses the vault; enable refuses while the
 *   projection is unavailable. A complete empty projection is not unavailable.
 * Every command runs the programs as their checked real paths and the credential helper as its checked
 * absolute path (production.ts resolveProductionConfig); a credential helper that is not trusted leaves a
 * GitHub vault's visibility unknown ("untrusted-credential-helper"), so it cannot be turned on.
 */
import { homedir } from "node:os";
import { devNull } from "node:os";
import { realpath } from "node:fs/promises";
import { createBackupEngine, type BackupEngine } from "../engine.ts";
import { checkDestination } from "../destination.ts";
import { urlDigest } from "../enablement.ts";
import { checkedNamespaces, inNamespace, ordinaryScopeTest, PROJECTED_TOTAL_LIMIT, PROJECTION_BUDGET_MS, projectionAttempt } from "../projection.ts";
import { createGitRunner, redact, type ProcessLauncher } from "../git-process.ts";
import { defaultMountInfo, isCloudSyncedLocation, isNetworkMount } from "../location.ts";
import { compileScope, listScope } from "../scope.ts";
import type { HelperConfig, RegisteredVault } from "./config.ts";
import { githubRepositoryOf, githubVisibilityCheck, gitCredentialSource, type GitHubUnknownReason } from "./github-visibility.ts";
import { HistoryProjectionMissingError, productionVaultOptions, requiredProjection, type ProductionSeams } from "./production.ts";
import { checkTool, ToolRefusedError, trustedCredentialHelper, type ToolCheck } from "./tools.ts";

const LISTED_LIMIT = 2_000;
/** The engine's default capture file limit; preview applies the same one to projected files. */
const PROJECTED_FILE_LIMIT = 100 * 1024 * 1024;

export type HistoryPreview =
  | { name: string; state: "complete"; files: number; bytes: number; items: string[]; omitted: number; summary: Record<string, number> }
  | { name: string; state: "unavailable"; reason: string };

export interface EnrolDeps extends ProductionSeams {
  launch?: ProcessLauncher;
  /** Test seam: the mount lookup (default: the platform's mount table). */
  mountInfo?: Parameters<typeof createBackupEngine>[0]["mountInfo"];
  homeDir?: string;
  /** Test seam: one projection attempt's budget in a preview (default projection.ts PROJECTION_BUDGET_MS). */
  projectionBudgetMs?: number;
}

export type VaultRemote =
  | { kind: "github"; repository: string }
  | { kind: "local"; path: string }
  | { kind: "unsupported"; display: string }
  | { kind: "missing" };

export interface VaultPreview {
  vault: string;
  root: string | null;
  /** Why this folder cannot be backed up at all; null when it can. */
  refused: string | null;
  tools: { git: ToolCheck | { error: string }; gitleaks: ToolCheck | { error: string } };
  credentialHelper: string | null;
  remote: VaultRemote;
  visibility: "private" | "public" | "unknown";
  visibilityReason: GitHubUnknownReason | "local-remote" | "no-credential-helper" | "untrusted-credential-helper" | "unsupported-remote" | null;
  scope: { include: string[]; exclude: string[] };
  /** SHA-256 of the validated remote address (enablement.ts urlDigest); null without one. Never the address. */
  destinationDigest: string | null;
  /** The required history projection's cohort as capture would insert it; null when the vault requires none. */
  history: HistoryPreview | null;
  files: { count: number; items: string[]; omitted: number };
  skipped: string[];
  unreadable: string[];
  enabled: boolean;
  publication: {
    /** Backup branches are named `backup/<machineId>/<checkout>/<date>` on the remote. */
    branchPrefix: string;
    /** Only snapshots of the listed files are sent, in a chain the engine made; the user's own commits are not. */
    userCommitsSent: false;
    /** A backup chain on this checkout that the engine did not make stops backup ("unsupported-history"); nothing is rewritten. */
    block: { reason: string; message: string } | null;
  };
}

function vaultOf(config: HelperConfig, id: string): RegisteredVault {
  const vault = config.vaults.find((v) => v.id === id);
  if (!vault) throw new Error(`no registered vault has id ${id}`);
  if (!config.tools) throw new Error("enrolment needs a version 2 configuration naming the git and gitleaks programs");
  return vault;
}

async function tool(which: "git" | "gitleaks", path: string): Promise<ToolCheck | { error: string }> {
  try {
    return await checkTool(which, path);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** The engine's location rules: a cloud-synced folder or a network drive (or one whose drive cannot be read). */
async function locationRefusal(real: string, deps: EnrolDeps): Promise<string | null> {
  const homes = new Set([deps.homeDir ?? homedir()]);
  for (const home of [...homes]) homes.add(await realpath(home).catch(() => home));
  for (const home of homes) {
    if (isCloudSyncedLocation(real, { homeDir: home, platform: process.platform, env: process.env }).cloud) return "this folder is inside a cloud-synced folder (such as OneDrive, iCloud Drive, Dropbox or Google Drive); automatic backup does not run there";
  }
  try {
    const mount = await (deps.mountInfo ?? defaultMountInfo(process.platform))(real);
    if (mount && isNetworkMount(mount)) return "this folder is on a network drive; automatic backup does not run there";
  } catch {
    return "could not check what kind of drive this folder is on; automatic backup does not run until it can";
  }
  return null;
}

function engineFor(config: HelperConfig, vault: RegisteredVault, deps: EnrolDeps): BackupEngine {
  return createBackupEngine({
    machineId: config.machineId,
    remote: vault.remote,
    ...productionVaultOptions(config, vault, deps.launch, deps),
    ...(deps.launch ? { launch: deps.launch } : {}),
    ...(deps.mountInfo ? { mountInfo: deps.mountInfo } : {}),
    ...(deps.homeDir ? { homeDir: deps.homeDir } : {}),
  });
}

/** The trusted credential helper's absolute real path; null when none is configured or it is not trusted. */
async function helperOf(config: HelperConfig, git: string): Promise<{ path: string } | { refused: true } | null> {
  if (!config.credentialHelper) return null;
  try {
    return { path: await trustedCredentialHelper(git, config.credentialHelper) };
  } catch {
    return { refused: true };
  }
}

/** The configuration as it runs: checked program paths and the checked helper (or none). */
function resolved(config: HelperConfig, git: string, gitleaks: string, helper: { path: string } | { refused: true } | null): HelperConfig {
  const { credentialHelper: _named, ...rest } = config;
  return { ...rest, tools: { git, gitleaks }, ...(helper && "path" in helper ? { credentialHelper: helper.path } : {}) };
}

export async function previewVault(config: HelperConfig, id: string, deps: EnrolDeps = {}): Promise<VaultPreview> {
  const vault = vaultOf(config, id);
  const tools = { git: await tool("git", config.tools!.git), gitleaks: await tool("gitleaks", config.tools!.gitleaks) };
  const helper = "error" in tools.git ? null : await helperOf(config, tools.git.path);
  const running = "error" in tools.git || "error" in tools.gitleaks ? config : resolved(config, tools.git.path, tools.gitleaks.path, helper);
  const preview: VaultPreview = {
    vault: id,
    root: null,
    refused: null,
    tools,
    credentialHelper: config.credentialHelper ?? null,
    remote: { kind: "missing" },
    visibility: "unknown",
    visibilityReason: null,
    scope: { include: [...vault.scope.include], exclude: [...(vault.scope.exclude ?? [])] },
    destinationDigest: null,
    history: null,
    files: { count: 0, items: [], omitted: 0 },
    skipped: [],
    unreadable: [],
    enabled: false,
    publication: { branchPrefix: `backup/${config.machineId}/`, userCommitsSent: false, block: null },
  };
  let projection;
  try {
    projection = requiredProjection(vault, deps.projections);
  } catch (error) {
    preview.refused = error instanceof HistoryProjectionMissingError ? error.message : "the history this vault requires cannot be read by this helper";
    return preview;
  }
  let real: string;
  try {
    real = await realpath(vault.path);
  } catch {
    preview.refused = "the folder cannot be found";
    return preview;
  }
  preview.root = real;
  preview.refused = await locationRefusal(real, deps);
  if (preview.refused) return preview;
  if ("error" in tools.git) {
    preview.refused = tools.git.error;
    return preview;
  }
  const git = createGitRunner({ gitPath: tools.git.path, hooksDir: devNull, ...(deps.launch ? { launch: deps.launch } : {}) });
  const run = { cwd: real, timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 };
  try {
    const top = (await git.ok(["rev-parse", "--show-toplevel"], run)).toString("utf8").trim();
    if ((await realpath(top)) !== real) {
      preview.refused = "this folder is inside a Git checkout, not its top folder; open the checkout's top folder to back it up";
      return preview;
    }
  } catch {
    preview.refused = "this folder is not a Git checkout";
    return preview;
  }
  const found = await checkDestination(git, run, vault.remote);
  if ("missing" in found) preview.remote = { kind: "missing" };
  else if ("unsupported" in found) preview.remote = { kind: "unsupported", display: found.unsupported };
  else {
    const url = found.destination.url;
    preview.destinationDigest = urlDigest(url);
    const repository = githubRepositoryOf(url);
    if (repository) preview.remote = { kind: "github", repository };
    else if (url.startsWith("/") || /^file:\/\/\//i.test(url)) preview.remote = { kind: "local", path: url };
    else preview.remote = { kind: "unsupported", display: redact(url).replace(/^(https:\/\/[^/]+).*$/i, "$1/…") };
    if (preview.remote.kind === "local") {
      preview.visibility = "private";
      preview.visibilityReason = "local-remote";
    } else if (preview.remote.kind === "github") {
      if (!config.credentialHelper && !deps.credential) preview.visibilityReason = "no-credential-helper";
      else if (!deps.credential && !(helper && "path" in helper)) preview.visibilityReason = "untrusted-credential-helper";
      else {
        const credential = deps.credential ?? gitCredentialSource({ gitPath: tools.git.path, helper: (helper as { path: string }).path, ...(deps.launch ? { launch: deps.launch } : {}) });
        const answer = await githubVisibilityCheck({ repository: preview.remote.repository, credential, ...(deps.fetch ? { fetch: deps.fetch } : {}) })(url);
        preview.visibility = answer.visibility;
        preview.visibilityReason = answer.visibility === "unknown" ? answer.reason : null;
      }
    } else preview.visibilityReason = "unsupported-remote";
  }
  const compiled = compileScope(vault.scope);
  const listing = await listScope(real, compiled);
  preview.files = { count: listing.files.length, items: listing.files.slice(0, LISTED_LIMIT), omitted: Math.max(0, listing.files.length - LISTED_LIMIT) };
  if (projection) {
    // The same projection and the same checks a capture applies (capture.ts), never a separate guess.
    const namespaces = checkedNamespaces(projection.namespaces);
    // The same engine-owned budget as a capture's (projection.ts readProjection): a host that never
    // answers ends this preview as unavailable instead of holding it.
    // The host's read and the cohort check are one admitted attempt under one budget, as in a capture.
    const budgetMs = deps.projectionBudgetMs ?? PROJECTION_BUDGET_MS;
    const cohort = listing.files.some((path) => inNamespace(path, namespaces))
      ? { unavailable: "an ordinary file in scope lies in the projection's own namespace" }
      : await projectionAttempt(projection, real, namespaces, { maxFileBytes: PROJECTED_FILE_LIMIT, maxTotalBytes: PROJECTED_TOTAL_LIMIT }, ordinaryScopeTest(compiled), { budgetMs });
    const answer = "answer" in cohort ? cohort.answer : undefined;
    if ("unavailable" in cohort) preview.history = { name: projection.name, state: "unavailable", reason: cohort.unavailable };
    else {
      const items = cohort.files.map((f) => f.path).sort();
      const raw: Record<string, unknown> = answer?.state === "complete" && answer.summary && typeof answer.summary === "object" ? answer.summary : {};
      const summary = Object.fromEntries(Object.entries(raw).filter(([k, v]) => /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(k) && Number.isSafeInteger(v) && (v as number) >= 0).slice(0, 8)) as Record<string, number>;
      preview.history = { name: projection.name, state: "complete", files: cohort.files.length, bytes: cohort.files.reduce((n, f) => n + f.content.length, 0), items: items.slice(0, LISTED_LIMIT), omitted: Math.max(0, items.length - LISTED_LIMIT), summary };
    }
  }
  preview.skipped = listing.skipped.map((s) => s.path);
  preview.unreadable = listing.unreadable;
  try {
    const status = await engineFor(running, preview.remote.kind === "github" ? { ...vault, github: { repository: preview.remote.repository } } : vault, deps).status(real);
    preview.enabled = status.enabled;
    if (status.block && status.block.reason === "unsupported-history") preview.publication.block = { reason: status.block.reason, message: status.block.message };
  } catch {
    // Status is informative here; enable re-checks everything.
  }
  return preview;
}

export type EnableAnswer = { enabled: true; root: string; visibility: "private" | "public" } | { enabled: false; reason: string };

export async function enableVault(config: HelperConfig, id: string, options: { confirmPublic: boolean; expectedDestinationDigest?: string }, deps: EnrolDeps = {}): Promise<EnableAnswer> {
  const vault = vaultOf(config, id);
  if (options.expectedDestinationDigest !== undefined && !/^[0-9a-f]{64}$/.test(options.expectedDestinationDigest)) return { enabled: false, reason: "the shown destination is not a destination digest" };
  const real: Partial<Record<"git" | "gitleaks", string>> = {};
  for (const which of ["git", "gitleaks"] as const) {
    try {
      real[which] = (await checkTool(which, config.tools![which])).path;
    } catch (error) {
      return { enabled: false, reason: error instanceof ToolRefusedError ? error.message : `${which}: could not be checked` };
    }
  }
  const running = resolved(config, real.git!, real.gitleaks!, await helperOf(config, real.git!));
  const preview = await previewVault(config, id, deps);
  if (preview.refused) return { enabled: false, reason: preview.refused };
  if (preview.remote.kind === "missing") return { enabled: false, reason: `the checkout has no remote named ${vault.remote}` };
  if (preview.remote.kind === "unsupported") return { enabled: false, reason: "the backup remote must be an HTTPS github.com repository or a local folder" };
  if (preview.remote.kind === "github" && vault.github?.repository.toLowerCase() !== preview.remote.repository.toLowerCase()) {
    return { enabled: false, reason: "the remote is not the GitHub repository this vault was registered with" };
  }
  if (preview.visibility === "unknown") return { enabled: false, reason: `whether the repository is private could not be checked (${preview.visibilityReason ?? "unknown"})` };
  if (preview.visibility === "public" && !options.confirmPublic) return { enabled: false, reason: "the repository is public; confirm publication to a public repository first" };
  // Required history that cannot be read completely now is never turned on as documents only.
  if (preview.history?.state === "unavailable") return { enabled: false, reason: `the history this vault requires is not available (${preview.history.reason})` };
  try {
    const result = await engineFor(running, vault, deps).enable(vault.path, {
      remote: vault.remote,
      visibilityConfirmedPublic: options.confirmPublic && preview.visibility === "public",
      ...(options.expectedDestinationDigest !== undefined ? { expectedDestinationDigest: options.expectedDestinationDigest } : {}),
    });
    if (result.visibility !== "private" && result.visibility !== "public") {
      await engineFor(running, vault, deps).disable(vault.path);
      return { enabled: false, reason: "the repository's visibility changed while backup was being turned on" };
    }
    return { enabled: true, root: result.realPath, visibility: result.visibility };
  } catch (error) {
    return { enabled: false, reason: redact(error instanceof Error ? error.message : String(error)).slice(0, 300) };
  }
}

export async function disableVault(config: HelperConfig, id: string, deps: EnrolDeps = {}): Promise<{ disabled: true }> {
  const vault = vaultOf(config, id);
  // Only the trusted Git runs; disabling needs no credential.
  const git = (await checkTool("git", config.tools!.git)).path;
  const gitleaks = (await checkTool("gitleaks", config.tools!.gitleaks)).path;
  // Removing the switch reads no history: a vault's required projection is not needed for it.
  const { history: _history, ...plain } = vault;
  await engineFor(resolved(config, git, gitleaks, null), plain, deps).disable(vault.path);
  return { disabled: true };
}
