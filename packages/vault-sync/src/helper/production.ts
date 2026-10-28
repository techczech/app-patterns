/**
 * Engine options for a production configuration (config.ts version 2). Nothing comes from the user's
 * shell: Git and gitleaks run from their configured absolute paths (checked by tools.ts at load), the
 * scanner searches no folders, HTTPS credentials come only from the configured helper, and visibility is
 * re-checked before every push.
 *
 * Visibility per vault: a local folder or file:// remote is private (it publishes nothing beyond this
 * machine, as before); a vault with a `github` repository uses githubVisibility; anything else is
 * "unknown", so its pushes stay held. A configuration without a credential helper has no way to check a
 * GitHub repository, so its GitHub vaults stay "unknown" too.
 *
 * Trusted programs (`resolveProductionConfig`, tools.ts): Git and gitleaks become their checked real
 * paths and the credential helper its checked absolute real path, before anything runs. Only a resolved
 * (absolute) helper is ever given to Git; an unresolved name gives no credential at all, so its GitHub
 * vaults stay "unknown". The same helper path and the same repository-scoped credential context
 * (`credential.useHttpPath=true`, through the engine's `gitEnv`, which it applies after dropping every
 * inherited GIT_* variable) are used for the visibility check and the push.
 *
 * Required history (config.ts `history`): the projection comes only from the helper entry's own trusted
 * code (`projections`, cli.ts HelperExtensions); a vault naming one the entry does not have is refused.
 */
import { isAbsolute } from "node:path";
import type { BackupEngineOptions, RemoteVisibility } from "../engine.ts";
import type { CaptureProjection } from "../projection.ts";
import type { ProcessLauncher } from "../git-process.ts";
import { createGitleaksScanner } from "../secret-scan.ts";
import type { HelperConfig, RegisteredVault } from "./config.ts";
import { gitCredentialSource, githubVisibility, type CredentialSource } from "./github-visibility.ts";
import { localVisibility } from "./server.ts";
import { checkTool, trustedCredentialHelper } from "./tools.ts";

/** Git configuration for every engine Git call: credentials are asked for per repository path. */
export const REPOSITORY_SCOPED_CREDENTIALS: Readonly<Record<string, string>> = Object.freeze({
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "credential.useHttpPath",
  GIT_CONFIG_VALUE_0: "true",
});

/**
 * The configuration with its programs replaced by their checked real paths. Throws ToolRefusedError or
 * CredentialHelperRefusedError naming the refusal. A version 1 configuration is returned as it is.
 */
export async function resolveProductionConfig(config: HelperConfig, uid?: number): Promise<HelperConfig> {
  if (!config.tools) return config;
  const git = (await checkTool("git", config.tools.git, uid)).path;
  const gitleaks = (await checkTool("gitleaks", config.tools.gitleaks, uid)).path;
  const credentialHelper = config.credentialHelper ? await trustedCredentialHelper(git, config.credentialHelper, uid) : undefined;
  return { ...config, tools: { git, gitleaks }, ...(credentialHelper ? { credentialHelper } : {}) };
}

export interface ProductionSeams {
  /** Test seam: the credential source (the default runs `git credential fill` through the configured helper). */
  credential?: CredentialSource;
  /** Test seam: the HTTP client for the GitHub API. */
  fetch?: typeof fetch;
  /** Trusted history projections this helper entry was built with, by name (never from configuration). */
  projections?: Readonly<Record<string, ProjectionFactory>>;
}

export type ProjectionFactory = (vault: RegisteredVault) => CaptureProjection;

export class HistoryProjectionMissingError extends Error {
  constructor(readonly history: string) {
    super(`this helper cannot back up the history this vault requires (${history}); backup stays off`);
    this.name = "HistoryProjectionMissingError";
  }
}

/** The vault's required projection: none when it requires none; throws when this entry lacks it. */
export function requiredProjection(vault: RegisteredVault, projections: ProductionSeams["projections"]): CaptureProjection | undefined {
  if (vault.history === undefined) return undefined;
  const factory = projections && Object.hasOwn(projections, vault.history) ? projections[vault.history] : undefined;
  if (typeof factory !== "function") throw new HistoryProjectionMissingError(vault.history);
  return factory(vault);
}

const isLocal = (url: string) => url.startsWith("/") || /^file:\/\/\//i.test(url);

/** Options every engine of this configuration shares; null for a version 1 configuration. */
export function productionSharedOptions(config: HelperConfig): Partial<BackupEngineOptions> | null {
  return config.tools ? { gitPath: config.tools.git, gitEnv: { ...REPOSITORY_SCOPED_CREDENTIALS } } : null;
}

/** The per-vault options: scanner, credential helper and visibility. `launch` is the helper's process registry (default `spawn`). */
export function productionVaultOptions(config: HelperConfig, vault: RegisteredVault, launch?: ProcessLauncher, seams: ProductionSeams = {}): Partial<BackupEngineOptions> {
  if (!config.tools) throw new Error("production options need a version 2 configuration");
  // Only a helper resolveProductionConfig checked (an absolute real path) ever runs.
  const helper = config.credentialHelper && isAbsolute(config.credentialHelper) ? config.credentialHelper : undefined;
  const credential = seams.credential ?? (helper ? gitCredentialSource({ gitPath: config.tools.git, helper, ...(launch ? { launch } : {}) }) : null);
  const github = vault.github && credential ? githubVisibility({ repository: vault.github.repository, credential, ...(seams.fetch ? { fetch: seams.fetch } : {}) }) : null;
  const remoteVisibility = (url: string): Promise<RemoteVisibility> => (isLocal(url) ? localVisibility(url) : github ? github(url) : Promise.resolve("unknown"));
  const historyProjection = requiredProjection(vault, seams.projections);
  return {
    ...(historyProjection ? { historyProjection } : {}),
    gitPath: config.tools.git,
    secretScanner: createGitleaksScanner({ gitleaksPath: config.tools.gitleaks, searchDirs: [], ...(launch ? { launch } : {}) }),
    trustedCredentialHelpers: helper ? [helper] : [],
    gitEnv: { ...REPOSITORY_SCOPED_CREDENTIALS },
    remoteVisibility,
    visibilityRecheckMs: 0,
  };
}
