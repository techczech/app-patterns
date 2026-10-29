/**
 * Production remote checks for an HTTPS GitHub backup remote: which repository the address is, whether it
 * is private, and the one credential the check and the push use.
 *
 * Repository identity: only `https://github.com/<owner>/<name>[.git]` is a GitHub remote here. An address
 * with a user name or password, a port, a query, a fragment, another host (including `www.github.com` and
 * GitHub Enterprise hosts) or any other path shape is not recognised, and its visibility stays "unknown",
 * so the engine holds every push. The repository must be the one the configuration names for that vault
 * (case-insensitive, as GitHub treats names); a remote changed to another repository is "unknown" too.
 *
 * Visibility: one `GET https://api.github.com/repos/<owner>/<name>` with the credential, 10 s, at most
 * 256 KiB (read incrementally: the count is checked before each chunk is kept, and the body is cancelled
 * once it passes the cap; a body that is not needed, after an early refusal, is cancelled unread),
 * redirects not followed (a renamed or transferred repository answers with a redirect, which is
 * refused rather than followed to a repository nobody confirmed). Only a 200 whose `full_name` is the
 * same repository and whose `private` flag agrees with its `visibility` field (where present) gives an
 * answer: private (also GitHub's "internal") or public. No credential, a refused credential, a missing
 * repository, rate limiting, a network failure or anything unexpected is "unknown": backup holds, never
 * reports green. The engine is asked to re-check before every push (production.ts), so a repository
 * made public stops the next push unless public publication was confirmed for it.
 *
 * Credential: Git's own credential protocol (`git credential fill`) through the one trusted helper the
 * configuration names (resolved and checked by tools.ts to an absolute path), with every other helper,
 * askpass program and terminal prompt cleared and the user's global and system Git configuration not
 * read. The request names the repository: `credential.useHttpPath=true` and `path=<owner>/<name>[.git]`
 * exactly as the remote address has it, which is what Git itself asks for the push (production.ts sets the
 * same `credential.useHttpPath` for the engine's Git), so a repository-scoped credential is found and one
 * repository's credential is never used for another. The token stays in this process; it is never
 * written, logged or put in an error message. The push itself uses the same helper (engine
 * `trustedCredentialHelpers`).
 */
import type { SpawnOptions } from "node:child_process";
import { spawn } from "node:child_process";
import { devNull } from "node:os";
import type { RemoteVisibility } from "../engine.ts";
import type { ProcessLauncher } from "../git-process.ts";
import { GITHUB_REPOSITORY } from "./config.ts";

export const GITHUB_API = "https://api.github.com";
const MAX_RESPONSE_BYTES = 256 * 1024;

/**
 * A plain GitHub HTTPS address: `repository` is `owner/name`; `credentialPath` is the URL path Git sends
 * as the credential `path` for it (`owner/name` or `owner/name.git`, as written). Null for anything else.
 */
export function githubRemoteOf(url: string): { repository: string; credentialPath: string } | null {
  if (typeof url !== "string" || !url.startsWith("https://github.com/")) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.port !== "" || parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") return null;
  // A trailing slash would make Git ask for another path than the one checked here: not recognised.
  const m = /^\/([^/]+)\/([^/]+?)(\.git)?$/.exec(parsed.pathname);
  if (!m) return null;
  const repository = `${m[1]}/${m[2]}`;
  return GITHUB_REPOSITORY.test(repository) ? { repository, credentialPath: `${repository}${m[3] ?? ""}` } : null;
}

/** `owner/name` of a plain GitHub HTTPS address, or null for anything else. */
export function githubRepositoryOf(url: string): string | null {
  return githubRemoteOf(url)?.repository ?? null;
}

/** The credential path of a validated remote: letters, digits, `.`, `_`, `-` and one `/`. */
const CREDENTIAL_PATH = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** Returns the github.com credential for one repository path, or null when none could be had. Never throws. */
export type CredentialSource = (request: { path: string }) => Promise<string | null>;

export interface GitCredentialOptions {
  gitPath: string;
  /** The one `credential.helper` value Git may run. */
  helper: string;
  launch?: ProcessLauncher;
  timeoutMs?: number;
}

/** Fields of a `git credential fill` answer; null when it is not one. */
export function parseCredentialAnswer(text: string): Map<string, string> | null {
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const eq = line.indexOf("=");
    if (eq <= 0) return null;
    fields.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return fields;
}

/** The github.com credential of one repository through Git's credential protocol and the trusted helper only. */
export function gitCredentialSource(options: GitCredentialOptions): CredentialSource {
  const launch: ProcessLauncher = options.launch ?? spawn;
  const timeoutMs = options.timeoutMs ?? 10_000;
  return (request) => new Promise<string | null>((resolve) => {
    const path = request?.path;
    if (typeof path !== "string" || !CREDENTIAL_PATH.test(path)) {
      resolve(null);
      return;
    }
    const env: Record<string, string> = {
      LC_ALL: "C",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: devNull,
    };
    for (const key of ["HOME", "USER", "LOGNAME", "TMPDIR"]) if (process.env[key]) env[key] = process.env[key]!;
    const spawnOptions: SpawnOptions = { cwd: "/", env, stdio: ["pipe", "pipe", "ignore"] };
    let child;
    try {
      child = launch(options.gitPath, ["-c", "credential.helper=", "-c", `credential.helper=${options.helper}`, "-c", "credential.useHttpPath=true", "-c", "core.askPass=", "credential", "fill"], spawnOptions);
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    let done = false;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* gone */ }
      finish(null);
    }, timeoutMs);
    child.on("error", () => finish(null));
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.length > 64 * 1024) {
        try { child.kill("SIGKILL"); } catch { /* gone */ }
        finish(null);
      }
    });
    child.on("close", (code) => {
      if (code !== 0) return finish(null);
      const fields = parseCredentialAnswer(out);
      const password = fields?.get("password");
      const answeredPath = fields?.get("path");
      const ok = fields && fields.get("protocol") === "https" && fields.get("host") === "github.com" && (answeredPath === undefined || answeredPath === path) && password && !/[\s\0]/.test(password);
      finish(ok ? password! : null);
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(`protocol=https\nhost=github.com\npath=${path}\n\n`);
  });
}

export interface GitHubVisibilityOptions {
  /** The repository the vault's remote must be (`owner/name`). */
  repository: string;
  repositoryId?: number;
  signal?: AbortSignal;
  credential: CredentialSource;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Why a check answered "unknown"; never carries the credential or the address. */
export type GitHubUnknownReason = "not-github-address" | "other-repository" | "no-credential" | "redirected" | "denied" | "not-found" | "rate-limited" | "http-error" | "network" | "unexpected-answer";

export type GitHubVisibilityAnswer = { visibility: "private" | "public" } | { visibility: "unknown"; reason: GitHubUnknownReason };

/** Cancels a body nobody will read; never throws. */
function discard(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // Already used or locked: nothing more to release.
  }
}

/** The body, read chunk by chunk and never past `cap` bytes; null (body cancelled) once it would pass. */
export async function readCapped(response: Response, cap: number): Promise<Uint8Array | null> {
  const body = response.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const kept: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const size = value?.byteLength ?? 0;
      if (total + size > cap) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      total += size;
      if (value) kept.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* cancelled */ }
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of kept) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** The visibility of the vault's GitHub repository with the reason for an "unknown". Never throws. */
export function githubVisibilityCheck(options: GitHubVisibilityOptions): (remoteUrl: string) => Promise<GitHubVisibilityAnswer> {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const expected = options.repository.toLowerCase();
  const unknown = (reason: GitHubUnknownReason): GitHubVisibilityAnswer => ({ visibility: "unknown", reason });
  return async (remoteUrl) => {
    if (options.signal?.aborted) return unknown("no-credential");
    const remote = githubRemoteOf(remoteUrl);
    if (!remote) return unknown("not-github-address");
    const { repository } = remote;
    if (repository.toLowerCase() !== expected) return unknown("other-repository");
    let token: string | null;
    try {
      token = await options.credential({ path: remote.credentialPath });
    } catch {
      token = null;
    }
    if (!token || options.signal?.aborted) return unknown("no-credential");
    let response: Response;
    try {
      response = await doFetch(`${GITHUB_API}/repos/${repository}`, {
        method: "GET",
        redirect: "manual",
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
        headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "vault-sync-helper" },
      });
    } catch {
      return unknown("network");
    }
    const refuse = (reason: GitHubUnknownReason): GitHubVisibilityAnswer => {
      discard(response);
      return unknown(reason);
    };
    if (response.status >= 300 && response.status < 400) return refuse("redirected");
    if (response.status === 401) return refuse("denied");
    if (response.status === 403 || response.status === 429) return refuse(response.headers.get("x-ratelimit-remaining") === "0" || response.status === 429 ? "rate-limited" : "denied");
    if (response.status === 404) return refuse("not-found");
    if (response.status !== 200) return refuse("http-error");
    try {
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > MAX_RESPONSE_BYTES) return refuse("unexpected-answer");
      const bytes = await readCapped(response, MAX_RESPONSE_BYTES);
      if (bytes === null) return unknown("unexpected-answer");
      const body = JSON.parse(new TextDecoder().decode(bytes)) as { id?: unknown; full_name?: unknown; private?: unknown; visibility?: unknown };
      if (options.signal?.aborted || (options.repositoryId !== undefined && body.id !== options.repositoryId)) return unknown("unexpected-answer");
      if (typeof body.full_name !== "string" || body.full_name.toLowerCase() !== expected || typeof body.private !== "boolean") return unknown("unexpected-answer");
      if (body.visibility !== undefined) {
        const agrees = body.private ? body.visibility === "private" || body.visibility === "internal" : body.visibility === "public";
        if (!agrees) return unknown("unexpected-answer");
      }
      return { visibility: body.private ? "private" : "public" };
    } catch {
      return unknown("network");
    }
  };
}

/** The visibility check for one vault's GitHub remote, as the engine takes it. Any doubt answers "unknown". */
export function githubVisibility(options: GitHubVisibilityOptions): (remoteUrl: string) => Promise<RemoteVisibility> {
  const check = githubVisibilityCheck(options);
  return async (remoteUrl) => (await check(remoteUrl)).visibility;
}
