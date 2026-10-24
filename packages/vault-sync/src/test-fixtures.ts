/** Test-only helpers: disposable repositories with local bare remotes, isolated from any user Git config. */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { scrubbedEnv } from "./git-process.ts";

export const isolatedGitEnv: Record<string, string> = { GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" };

const env = () => scrubbedEnv(process.env, {
  ...isolatedGitEnv,
  GIT_AUTHOR_NAME: "Test Writer",
  GIT_AUTHOR_EMAIL: "writer@example.invalid",
  GIT_COMMITTER_NAME: "Test Writer",
  GIT_COMMITTER_EMAIL: "writer@example.invalid",
});

export function git(cwd: string, args: string[], input?: string | Buffer): Buffer {
  const result = spawnSync("git", args, { cwd, env: env(), input, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout;
}

export function gitText(cwd: string, args: string[], input?: string | Buffer): string {
  return git(cwd, args, input).toString("utf8").trim();
}

export function gitAsync(cwd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, env: env(), stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
    child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
  });
}

export interface Sandbox {
  dir: string;
  repo: string;
  remote: string;
  cleanup(): void;
}

/** A worktree with one commit and a bare remote named origin, inside one mkdtemp folder. */
export function sandbox(): Sandbox {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "vault-sync-test-")));
  const repo = join(dir, "vault");
  const remote = join(dir, "remote.git");
  git(dir, ["init", "-q", "--bare", "-b", "main", remote]);
  git(dir, ["init", "-q", "-b", "main", repo]);
  git(repo, ["remote", "add", "origin", remote]);
  return { dir, repo, remote, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const tick = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
