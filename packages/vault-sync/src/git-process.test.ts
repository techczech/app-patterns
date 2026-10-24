import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitRunner, GitProcessError, redact, scrubbedEnv, splitNul } from "./git-process.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "vault-sync-process-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A stand-in executable, so limits can be tested without a slow or chatty real git command. */
function fakeGit(name: string, body: string): string {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

const base = { cwd: dir, timeoutMs: 5000, maxOutputBytes: 1024 * 1024 };
const posix = process.platform !== "win32";

describe("git process adapter", () => {
  test.if(posix)("a timeout kills the process", async () => {
    const runner = createGitRunner({ gitPath: fakeGit("slow", "sleep 30"), hooksDir: dir });
    const started = Date.now();
    const error = await runner.run(["status"], { ...base, timeoutMs: 200 }).catch((e) => e);
    expect(error).toBeInstanceOf(GitProcessError);
    expect((error as GitProcessError).kind).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test.if(posix)("an abort signal kills the process", async () => {
    const runner = createGitRunner({ gitPath: fakeGit("slow2", "sleep 30"), hooksDir: dir });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const error = await runner.run(["push"], { ...base, signal: controller.signal }).catch((e) => e);
    expect((error as GitProcessError).kind).toBe("aborted");
  });

  test.if(posix)("output beyond the limit stops the process", async () => {
    const runner = createGitRunner({ gitPath: fakeGit("chatty", "yes"), hooksDir: dir });
    const error = await runner.run(["log"], { ...base, maxOutputBytes: 64 * 1024 }).catch((e) => e);
    expect((error as GitProcessError).kind).toBe("output-limit");
  });

  test.if(posix)("arguments reach git as an array, never through a shell, with hook and maintenance overrides first", async () => {
    const runner = createGitRunner({ gitPath: fakeGit("echoargs", 'for a in "$@"; do printf "%s\\0" "$a"; done'), hooksDir: "/engine/hooks" });
    const out = await runner.ok(["show", "$(touch x); `id`", "a b\tc\nd"], base);
    expect(splitNul(out)).toEqual(["-c", "core.hooksPath=/engine/hooks", "-c", "core.fsmonitor=false", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "show", "$(touch x); `id`", "a b\tc\nd"]);
  });

  test("environment drops repository-redirecting GIT_* variables and turns prompts off", () => {
    const env = scrubbedEnv({ GIT_DIR: "/elsewhere", GIT_INDEX_FILE: "/x", GIT_WORK_TREE: "/y", GIT_SSH_COMMAND: "ssh", PATH: "/bin" }, { GIT_INDEX_FILE: "/private" });
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.GIT_INDEX_FILE).toBe("/private");
    expect(env.GIT_SSH_COMMAND).toBe("ssh");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.PATH).toBe("/bin");
  });

  test("credentials in URLs are redacted from messages", () => {
    expect(redact("fatal: unable to access 'https://user:token123@host.example/repo.git/'")).toBe("fatal: unable to access 'https://***@host.example/repo.git/'");
  });
});
