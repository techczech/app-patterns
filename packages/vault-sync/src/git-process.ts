/**
 * Narrow process adapter for native Git.
 *
 * - argument arrays only, never a shell;
 * - bounded run time and output size; an abort signal or timeout kills the process group;
 * - the caller's GIT_* environment is dropped (it could redirect the repository, index or object store),
 *   except a small transport allow-list; terminal prompts are off;
 * - every invocation carries config overrides that keep Git from running repository hooks, the
 *   file-system monitor or automatic maintenance on the engine's behalf;
 * - stderr is capped and credentials in URLs are redacted before it leaves this module.
 */
import { spawn } from "node:child_process";

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
}

export function createGitRunner(config: GitRunnerConfig): GitRunner {
  const gitPath = config.gitPath ?? "git";
  const prefix = [
    "-c", `core.hooksPath=${config.hooksDir}`,
    "-c", "core.fsmonitor=false",
    "-c", "gc.auto=0",
    "-c", "maintenance.auto=false",
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
          env: scrubbedEnv(process.env, { ...config.env, ...options.env }),
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
        resolve({ code: code ?? -1, stdout: Buffer.concat(chunks), stderr: redact(stderr) });
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
