import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
setDefaultTimeout(30_000);
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolatedGitEnv, sandbox } from "../test-fixtures.ts";
import { listProcessesSync } from "./containment.ts";
import { startHelper } from "./server.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const here = import.meta.dir;

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "vsh-fg-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** True while `pid` exists and is not a zombie. */
function running(pid: number): boolean {
  const row = listProcessesSync().find((r) => r.pid === pid);
  return row !== undefined && !row.zombie;
}

async function until(check: () => boolean, ms = 5_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await pause(20)) if (check()) return true;
  return check();
}

function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((res) => (child.exitCode !== null ? res(child.exitCode) : child.once("exit", (code) => res(code))));
}

// Containment passes themselves are tested in process-ownership.test.ts.

describe("the foreground command ends in bounded time and keeps ownership through the end of every writer (review finding 3)", () => {
  function launch(mode: "ignore-abort" | "cooperate") {
    const sb = sandbox();
    cleanups.push(() => sb.cleanup());
    const dir = scratch();
    const rt = join(dir, "rt");
    const pidFile = join(dir, "child.pid");
    const script = join(dir, "run.ts");
    writeFileSync(script, `
      import { spawn } from "node:child_process";
      import { writeFileSync } from "node:fs";
      import { startHelper } from ${JSON.stringify(join(here, "server.ts"))};
      import { runForeground } from ${JSON.stringify(join(here, "cli.ts"))};
      const [repo, rt, pidFile, mode, gitEnv] = process.argv.slice(2);
      const nothing = { committed: false, snapshot: null, ref: null, startedAt: 0, added: [], modified: [], removed: [], pending: [], skipped: [] };
      const handle = await startHelper({
        config: { machineId: "fg", captureIntervalMs: 1000, vaults: [{ id: "v", path: repo, scope: { include: ["notes"] }, remote: "origin" }] },
        runtimeDir: rt, maxRuntimeMs: 60000, shutdownGraceMs: 50, hardStopMs: 300, engineOptions: { gitEnv: JSON.parse(gitEnv) },
        onEvent: (e) => process.stderr.write(JSON.stringify(e) + "\\n"),
        createEngine: () => ({
          capture: async (_r, _s, o) => {
            // Stands in for a Git command in its own process group that this engine does not stop.
            const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
            writeFileSync(pidFile, String(child.pid));
            if (mode === "cooperate") {
              await new Promise((r) => o.signal.addEventListener("abort", r));
              process.kill(-child.pid, "SIGKILL");
              return nothing;
            }
            return new Promise(() => undefined);
          },
          pushBackup: async () => { throw new Error("unused"); },
          verify: async () => { throw new Error("unused"); },
          status: async () => { throw new Error("unused"); },
        }),
      });
      process.exit(await runForeground(handle));
    `);
    const child = spawn(process.execPath, [script, sb.repo, rt, pidFile, mode, JSON.stringify(isolatedGitEnv)], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr!.on("data", (b) => { stderr += b.toString(); });
    cleanups.push(() => void child.kill("SIGKILL"));
    return { sb, rt, pidFile, child, stderr: () => stderr };
  }

  const tickets = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith("ticket-")) : []);

  test("work that ignores cancellation: children are killed and confirmed gone, then the process exits 3 with its claims left to die with it", async () => {
    const run = launch("ignore-abort");
    expect(await until(() => existsSync(run.pidFile))).toBe(true);
    const writer = Number(readFileSync(run.pidFile, "utf8"));
    expect(running(writer)).toBe(true);
    const t0 = Date.now();
    run.child.kill("SIGTERM");
    await pause(20);
    run.child.kill("SIGINT");
    const code = await exited(run.child);
    const elapsed = Date.now() - t0;
    expect(code).toBe(3);
    expect(elapsed).toBeLessThan(10_000);
    expect(running(writer)).toBe(false);
    const events = run.stderr().trim().split("\n").map((l) => JSON.parse(l) as { type: string });
    expect(events.map((e) => e.type)).toEqual(["started", "stopping", "signal-ignored", "overdue", "forced-exit"]);
    // The claims were not released by the process; they go stale with it and a successor reclaims them.
    expect(tickets(join(run.rt, "owner.lock")).length).toBe(1);
    expect(tickets(join(run.sb.repo, ".git", "vault-sync", "helper-owner")).length).toBe(1);
    const successor = await startHelper({
      config: { machineId: "fg", captureIntervalMs: 3_600_000, vaults: [{ id: "v", path: run.sb.repo, scope: { include: ["notes"] }, remote: "origin" }] },
      runtimeDir: run.rt, maxRuntimeMs: 10_000, engineOptions: { gitEnv: isolatedGitEnv },
      createEngine: () => ({ capture: async () => { throw new Error("unused"); }, pushBackup: async () => { throw new Error("unused"); }, verify: async () => { throw new Error("unused"); }, status: async () => { throw new Error("unused"); } }),
    });
    expect(await successor.stop()).toEqual({ state: "stopped" });
  });

  test("work that honours cancellation: the process exits 0 with the socket removed and the claims released", async () => {
    const run = launch("cooperate");
    expect(await until(() => existsSync(run.pidFile))).toBe(true);
    const writer = Number(readFileSync(run.pidFile, "utf8"));
    run.child.kill("SIGTERM");
    expect(await exited(run.child)).toBe(0);
    expect(await until(() => !running(writer))).toBe(true);
    expect(tickets(join(run.rt, "owner.lock"))).toEqual([]);
    expect(existsSync(join(run.rt, "helper.sock"))).toBe(false);
  });
});
