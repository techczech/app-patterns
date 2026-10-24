/**
 * Narrow process adapter for native Git.
 *
 * - argument arrays only, never a shell;
 * - bounded run time and output size; an abort signal or timeout kills the process group;
 * - the caller's GIT_* environment is dropped (it could redirect the repository, index or object store),
 *   except a small transport allow-list; terminal prompts are off;
 * - every invocation carries config overrides that keep Git from running repository hooks, the
 *   file-system monitor, automatic maintenance or signature checks on the engine's behalf, and that limit
 *   what the repository's configuration can make Git execute: the repository's credential helpers and
 *   askpass program are cleared, and only the helpers the caller names in `credentialHelpers` run;
 * - only the file and HTTPS transports are allowed (no SSH command, proxy command or remote helper). This
 *   is set with GIT_ALLOW_PROTOCOL after every other environment value, because Git lets a
 *   protocol-specific setting such as `protocol.ext.allow` in repository configuration override
 *   `protocol.allow`, but nothing overrides GIT_ALLOW_PROTOCOL; replacement refs and grafts are ignored;
 * - network operations do not run here against the repository's configuration at all: see transport.ts;
 * - stderr is capped and credentials in URLs are redacted before it leaves this module.
 */
import { spawn } from "node:child_process";
import { devNull } from "node:os";

export type GitFailureKind = "timeout" | "aborted" | "output-limit" | "spawn" | "exit";

export class GitProcessError extends Error {
  readonly kind: GitFailureKind;
  readonly code: number | null;
  readonly stderr: string;
  constructor(kind: GitFailureKind, message: string, code: number | null = null, stderr = "") {
    super(message);
    this.name = "GitProcessError";
    this.kind = kind;
    this.code = code;
    this.stderr = stderr;
  }
}

export interface GitRunOptions {
  cwd: string;
  /** Extra environment applied after the GIT_* scrub (for example GIT_INDEX_FILE, identities). */
  env?: Record<string, string>;
  input?: Uint8Array;
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
  /** Keep only the first N bytes of stdout, then stop the process and resolve with them (code 0). */
  stopAfterBytes?: number;
}

export interface GitResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

export interface GitRunner {
  /** Runs git and resolves with the exit code; rejects only for timeout, abort, output limit or spawn failure. */
  run(args: readonly string[], options: GitRunOptions): Promise<GitResult>;
  /** Like run, but a non-zero exit rejects with kind "exit". */
  ok(args: readonly string[], options: GitRunOptions): Promise<Buffer>;
}

const STDERR_CAP = 16 * 1024;
/** The only transports Git may use for the engine; set last, so nothing configured can widen it. */
export const ALLOWED_PROTOCOLS = "file:https";
/**
 * Set last on every call. Replacement refs and a grafts file would make Git read a different history
 * than the objects it stores, so what the engine checks and scans could differ from what a push sends.
 */
const ENFORCED_ENV = { GIT_ALLOW_PROTOCOL: ALLOWED_PROTOCOLS, GIT_NO_REPLACE_OBJECTS: "1", GIT_GRAFT_FILE: devNull };
const KEEP_ENV = new Set(["GIT_ASKPASS", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_SSL_CAINFO", "GIT_SSL_CAPATH", "GIT_EXEC_PATH"]);

/** Removes user:password@ and token@ parts from URLs in a message. */
export function redact(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@");
}

export function scrubbedEnv(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (key.toUpperCase().startsWith("GIT_") && !KEEP_ENV.has(key.toUpperCase())) continue;
    env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.LC_ALL = "C";
  return { ...env, ...extra };
}

export interface GitRunnerConfig {
  gitPath?: string;
  /** Directory used as core.hooksPath; it must stay empty so no hook can run. */
  hooksDir: string;
  /** Environment passed through after the scrub on every call (tests use it to isolate global config). */
  env?: Record<string, string>;
  /**
   * Credential helpers Git may run for HTTPS, as `credential.helper` values (for example "osxkeychain").
   * These are trusted by the caller; every helper configured by the repository or the user's Git
   * configuration is cleared first. Default none.
   */
  credentialHelpers?: readonly string[];
}

export function createGitRunner(config: GitRunnerConfig): GitRunner {
  const gitPath = config.gitPath ?? "git";
  const prefix = [
    "-c", `core.hooksPath=${config.hooksDir}`,
    "-c", "core.fsmonitor=false",
    "-c", "gc.auto=0",
    "-c", "maintenance.auto=false",
    "-c", "log.showSignature=false",
    "-c", "protocol.allow=never",
    "-c", "protocol.file.allow=always",
    "-c", "protocol.https.allow=always",
    "-c", "core.askPass=",
    "-c", "credential.helper=",
    ...(config.credentialHelpers ?? []).flatMap((helper) => {
      if (typeof helper !== "string" || helper === "" || /[\0\n]/.test(helper)) throw new Error("a credential helper must be a non-empty single-line string");
      return ["-c", `credential.helper=${helper}`];
    }),
  ];

  const run = (args: readonly string[], options: GitRunOptions): Promise<GitResult> =>
    new Promise((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(new GitProcessError("aborted", "git was cancelled before it started"));
        return;
      }
      const useGroup = process.platform !== "win32";
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(gitPath, [...prefix, ...args], {
          cwd: options.cwd,
          env: { ...scrubbedEnv(process.env, { ...config.env, ...options.env }), ...ENFORCED_ENV },
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
          windowsHide: true,
          detached: useGroup,
        });
      } catch (error) {
        reject(new GitProcessError("spawn", `git could not start: ${(error as Error).message}`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let stderr = "";
      let failure: GitProcessError | null = null;
      let settled = false;
      let stopped = false;

      const kill = () => {
        try {
          if (useGroup && child.pid) process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
        }
      };
      const fail = (error: GitProcessError) => {
        if (failure) return;
        failure = error;
        kill();
      };
      const timer = setTimeout(() => fail(new GitProcessError("timeout", `git ${args[0] ?? ""} exceeded ${options.timeoutMs} ms`)), options.timeoutMs);
      const onAbort = () => fail(new GitProcessError("aborted", `git ${args[0] ?? ""} was cancelled`));
      options.signal?.addEventListener("abort", onAbort, { once: true });

      child.stdout!.on("data", (chunk: Buffer) => {
        if (stopped) return;
        const stopAt = options.stopAfterBytes;
        if (stopAt !== undefined && size + chunk.length >= stopAt) {
          chunks.push(chunk.subarray(0, stopAt - size));
          size = stopAt;
          stopped = true;
          kill();
          return;
        }
        size += chunk.length;
        if (size > options.maxOutputBytes) {
          fail(new GitProcessError("output-limit", `git ${args[0] ?? ""} produced more than ${options.maxOutputBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      child.stderr!.on("data", (chunk: Buffer) => {
        if (stderr.length < STDERR_CAP) stderr += chunk.toString("utf8").slice(0, STDERR_CAP - stderr.length);
      });
      child.stdin!.on("error", () => { /* the process may exit before reading all input */ });
      child.on("error", (error) => {
        if (!failure) failure = new GitProcessError("spawn", `git could not start: ${error.message}`);
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        if (failure) {
          reject(failure);
          return;
        }
        resolve({ code: stopped ? 0 : code ?? -1, stdout: Buffer.concat(chunks), stderr: redact(stderr) });
      });
      if (options.input) child.stdin!.end(Buffer.from(options.input));
      else child.stdin!.end();
    });

  return {
    run,
    async ok(args, options) {
      const result = await run(args, options);
      if (result.code !== 0) {
        throw new GitProcessError("exit", `git ${args[0] ?? ""} failed (${result.code}): ${result.stderr.trim().split("\n").slice(-3).join(" ")}`, result.code, result.stderr);
      }
      return result.stdout;
    },
  };
}

/** Splits NUL-terminated output into records, dropping the trailing empty record. */
export function splitNul(buffer: Buffer): string[] {
  const text = buffer.toString("utf8");
  const parts = text.split("\0");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}
