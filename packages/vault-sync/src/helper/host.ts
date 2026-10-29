/**
 * The seam for a host's own helper entry: the generic commands and lifecycle of cli.ts, with the host's
 * trusted history projections (production.ts, projection.ts). A host builds its own entry file that calls
 * `runCli(argv, { projections })` and starts that file as the helper; it never imports this into an app
 * process. Projections are code of that entry, chosen by name in the configuration, never loaded from it.
 */
export { main, runCli, type HelperExtensions } from "./cli.ts";
export { HistoryProjectionMissingError, type ProjectionFactory } from "./production.ts";
export type { RegisteredVault } from "./config.ts";
export { checkedNamespaces, inNamespace, ordinaryScopeTest, plainGitPath, type CaptureProjection, type ProjectedFile, type ProjectionRead } from "../projection.ts";

export type { HostCredentialFactory } from "./production.ts";
export type { ProcessLauncher } from "../git-process.ts";
