import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
setDefaultTimeout(30_000);
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { withFolderLock } from "../engine-store.ts";
import { createGitRunner } from "../git-process.ts";
import { createGitleaksScanner } from "../secret-scan.ts";
import { isolatedGitEnv, sandbox } from "../test-fixtures.ts";
import { runForeground } from "./cli.ts";
import { listProcessesSync, sweepSync, type ContainmentResult, type ProcessRow } from "./containment.ts";
import { createProcessRegistry, type ProcessRegistry } from "./process-registry.ts";
import { startHelper, type HelperHandle, type StopResult } from "./server.ts";

const here = import.meta.dir;
const src = join(here, "..");
const cleanups: Array<() => void | Promise<void>> = [];
/** Fixture writers this file started; cleanup signals only these. */
const fixturePids = new Set<number>();
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  for (const pid of fixturePids) if (running(pid)) process.kill(pid, "SIGKILL");
  fixturePids.clear();
});

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "vsh-own-")));
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

function exited(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((res) => (child.exitCode !== null || child.signalCode !== null ? res({ code: child.exitCode, signal: child.signalCode }) : child.once("exit", (code, signal) => res({ code, signal }))));
}

const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

interface WriterFixture {
  dir: string;
  beat: string;
  pidFile: string;
  /** Pid of the writer, once it has started; recorded for cleanup. */
  pid(): number;
  /** True while the heartbeat file keeps changing. */
  beating(): Promise<boolean>;
}

/** A writer stand-in that rewrites a heartbeat file every 20 ms and ends itself after 20 s. */
function writerFixture(name = "w"): WriterFixture & { script: string } {
  const dir = scratch();
  const script = join(dir, `${name}-writer.ts`);
  const beat = join(dir, `${name}.beat`);
  const pidFile = join(dir, `${name}.pid`);
  writeFileSync(script, `import { writeFileSync } from "node:fs"; setInterval(() => writeFileSync(${JSON.stringify(beat)}, String(performance.now())), 20); setTimeout(() => process.exit(0), 20000);`);
  const fixture = {
    dir, script, beat, pidFile,
    pid() {
      const pid = Number(readFileSync(pidFile, "utf8"));
      fixturePids.add(pid);
      return pid;
    },
    async beating() {
      if (!existsSync(beat)) return false;
      const before = readFileSync(beat, "utf8");
      await pause(150);
      return readFileSync(beat, "utf8") !== before;
    },
  };
  return fixture;
}

/**
 * An executable standing in for Git or gitleaks: it starts the writer in the background with its output
 * redirected, records the writer's pid, writes an empty report when given --report-path, and exits 0 at
 * once. The writer is left in the command's process group with launchd as its parent.
 */
function leavingCommand(w: WriterFixture & { script: string }): string {
  const path = join(w.dir, "leaving-command");
  writeFileSync(path, `#!/bin/sh
(cd ${q(w.dir)} && exec ${q(process.execPath)} ${q(w.script)} >/dev/null 2>&1) &
echo $! > ${q(w.pidFile)}
while [ $# -gt 0 ]; do
  if [ "$1" = "--report-path" ]; then echo '[]' > "$2"; fi
  shift
done
exit 0
`, { mode: 0o700 });
  return path;
}

const tickets = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith("ticket-")) : []);

describe("process ownership is established at launch and kept after the command closes (review R2-2)", () => {
  test("Git: a process left in a closed command's group stays owned although its parent is now launchd, and only ending the registry ends it", async () => {
    const w = writerFixture();
    const registry = createProcessRegistry();
    cleanups.push(() => registry.end());
    const git = createGitRunner({ gitPath: leavingCommand(w), hooksDir: devNull, launch: registry.launch });
    await git.ok(["status"], { cwd: w.dir, timeoutMs: 5_000, maxOutputBytes: 1_000 });
    expect(await until(() => existsSync(w.pidFile) && existsSync(w.beat))).toBe(true);
    const writer = w.pid();
    const row = listProcessesSync().find((r) => r.pid === writer)!;
    expect(row.ppid).toBe(1);
    expect(registry.live()).toEqual([row.pgid]);
    await pause(1_200); // past a prune
    expect(registry.live()).toEqual([row.pgid]);
    expect(await w.beating()).toBe(true);
    await registry.end();
    expect(running(writer)).toBe(false);
    expect(registry.live()).toEqual([]);
    // Sealed: nothing new may start.
    await expect(git.ok(["status"], { cwd: w.dir, timeoutMs: 5_000, maxOutputBytes: 1_000 })).rejects.toMatchObject({ kind: "spawn" });
  });

  test("scanner: the secret scanner's process is owned the same way", async () => {
    const w = writerFixture();
    const registry = createProcessRegistry();
    cleanups.push(() => registry.end());
    const scan = createGitleaksScanner({ gitleaksPath: leavingCommand(w), searchDirs: [], launch: registry.launch });
    expect(await scan([{ path: "notes/a.md", oid: "0".repeat(40), bytes: Buffer.from("plain text") }])).toEqual({ findings: [] });
    expect(await until(() => existsSync(w.pidFile) && existsSync(w.beat))).toBe(true);
    const writer = w.pid();
    expect(registry.live().length).toBe(1);
    expect(await w.beating()).toBe(true);
    await registry.end();
    expect(running(writer)).toBe(false);
    // Sealed: a later scan cannot start its process, so it reports the scanner unavailable.
    expect(await scan([{ path: "notes/a.md", oid: "0".repeat(40), bytes: Buffer.from("plain text") }])).toHaveProperty("unavailable");
  });

  test("ending a registry never touches a process it did not start", async () => {
    const registry = createProcessRegistry();
    const unrelated = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
    fixturePids.add(unrelated.pid!);
    const owned = registry.launch("/bin/sleep", ["30"], { stdio: "ignore" });
    await registry.end();
    expect(running(owned.pid!)).toBe(false);
    expect(running(unrelated.pid!)).toBe(true);
  });
});

/** Passes until one is confirmed, yielding between passes so killed children are reaped. */
async function sweepUntilConfirmed(pass: () => ContainmentResult, ms = 5_000): Promise<ContainmentResult> {
  let result = pass();
  for (const end = Date.now() + ms; !result.confirmed && Date.now() < end; result = pass()) await pause(20);
  return result;
}

describe("one containment pass (review R2-1)", () => {
  test("a process list that cannot be read is never confirmed; recorded groups are still killed", async () => {
    const registry = createProcessRegistry();
    cleanups.push(() => registry.end());
    const child = registry.launch("/bin/sleep", ["30"], { stdio: "ignore" });
    const failing = () => { throw new Error("spawnSync /bin/ps EPERM"); };
    const first = sweepSync({ processes: registry, list: failing });
    expect(first.confirmed).toBe(false);
    expect(first.listError).toContain("EPERM");
    expect(first.killed).toContain(-child.pid!);
    expect(registry.sealed).toBe(true);
    // The recorded group is gone, but without a list nothing is ever confirmed.
    const stillFailing = await sweepUntilConfirmed(() => sweepSync({ processes: registry, list: failing }), 500);
    expect(stillFailing.confirmed).toBe(false);
    expect(running(child.pid!)).toBe(false);
    expect((await sweepUntilConfirmed(() => sweepSync({ processes: registry }))).confirmed).toBe(true);
  });

  test("signals only owned processes and groups: never the root, its own or its parent's group, or an unrelated group", () => {
    const row = (pid: number, ppid: number, pgid: number, zombie = false): ProcessRow => ({ pid, ppid, pgid, zombie });
    const rows = [
      row(899, 1, 900), // the shell that started the helper
      row(1000, 899, 900), // the helper
      row(1001, 1000, 900), // plain child in the helper's group
      row(1002, 1000, 1002), // child leading its own group
      row(1003, 1, 1002), // orphaned member of that group
      row(1004, 1000, 2000), // child that joined an unrelated group
      row(2000, 1, 2000), // unrelated group leader
      row(2001, 2000, 2000), // unrelated member
      row(1005, 1000, 1005, true), // zombie child
    ];
    const registry: ProcessRegistry = { launch: () => { throw new Error("unused"); }, seal: () => undefined, sealed: true, live: () => [3000], killLive: () => [], end: async () => undefined };
    const signalled: number[] = [];
    const kill = (target: number, signal: NodeJS.Signals | 0) => {
      if (signal === 0) {
        if (!rows.some((r) => r.pid === target && !r.zombie)) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
        return;
      }
      signalled.push(target);
    };
    const result = sweepSync({ processes: registry, rootPid: 1000, list: () => rows, kill });
    expect(result.confirmed).toBe(false);
    // -1005: a group led by a zombie child can still hold live members, so it is owned and signalled too.
    expect([...signalled].sort((a, b) => a - b)).toEqual([-3000, -1005, -1002, 1001, 1002, 1003, 1004]);
  });

  test("a real tree: descendants and the members of groups they lead are killed and confirmed gone; the root is not touched", async () => {
    const dir = scratch();
    const script = join(dir, "tree.ts");
    writeFileSync(script, `
      import { spawn } from "node:child_process";
      const grouped = spawn("/bin/sh", ["-c", "sleep 60 & sleep 60"], { detached: true, stdio: "ignore" });
      const plain = spawn("sleep", ["60"], { stdio: "ignore" });
      setTimeout(() => process.stdout.write(JSON.stringify({ grouped: grouped.pid, plain: plain.pid }) + "\\n"), 200);
      setInterval(() => undefined, 1000);
    `);
    const root = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "ignore"] });
    fixturePids.add(root.pid!);
    const pids = await new Promise<{ grouped: number; plain: number }>((res) => root.stdout!.once("data", (b) => res(JSON.parse(b.toString()))));
    const members = () => listProcessesSync().filter((r) => r.pgid === pids.grouped && !r.zombie).map((r) => r.pid);
    for (const pid of [...members(), pids.plain]) fixturePids.add(pid);
    expect(members().length).toBe(3);
    const empty = createProcessRegistry();
    // The root is another process here, so its killed children are reaped by it, not by this test.
    const result = await sweepUntilConfirmed(() => sweepSync({ processes: empty, rootPid: root.pid! }));
    expect(result.confirmed).toBe(true);
    expect(running(pids.plain)).toBe(false);
    expect(members()).toEqual([]);
    expect(running(root.pid!)).toBe(true);
  });
});

const nothing = { committed: false, snapshot: null, ref: null, startedAt: 0, added: [], modified: [], removed: [], pending: [], skipped: [] };

describe("a normal stop releases the claims only after every owned process is gone (review R2-2 through the helper)", () => {
  test("a cycle whose Git command left a writer behind: 'stopped' comes, and the claims go, only after the writer is gone", async () => {
    const sb = sandbox();
    cleanups.push(() => sb.cleanup());
    const w = writerFixture();
    const command = leavingCommand(w);
    const rt = join(scratch(), "rt");
    let ran = false;
    const handle = await startHelper({
      config: { machineId: "own", captureIntervalMs: 1_000, vaults: [{ id: "v", path: sb.repo, scope: { include: ["notes"] }, remote: "origin" }] },
      runtimeDir: rt, maxRuntimeMs: 60_000, shutdownGraceMs: 50, hardStopMs: 5_000, engineOptions: { gitEnv: isolatedGitEnv },
      createEngine: (_vault, options) => ({
        capture: async () => {
          if (!ran) await createGitRunner({ gitPath: command, hooksDir: devNull, launch: options.launch }).ok(["status"], { cwd: w.dir, timeoutMs: 5_000, maxOutputBytes: 1_000 });
          ran = true;
          return nothing as never;
        },
        pushBackup: async () => { throw new Error("unused"); },
        verify: async () => { throw new Error("unused"); },
        status: async () => { throw new Error("unused"); },
      }),
    });
    expect(await until(() => ran && existsSync(w.pidFile) && existsSync(w.beat))).toBe(true);
    const writer = w.pid();
    expect(await w.beating()).toBe(true);
    let writerAtRelease: boolean | undefined;
    void handle.done.then(() => { writerAtRelease = running(writer); });
    expect(await handle.stop("test")).toEqual({ state: "stopped" });
    expect(writerAtRelease).toBe(false);
    expect(running(writer)).toBe(false);
    expect(tickets(join(rt, "owner.lock"))).toEqual([]);
    expect(tickets(join(sb.repo, ".git", "vault-sync", "helper-owner"))).toEqual([]);
  });
});

/** Runs a script with Bun in a child process, collecting its event lines from stderr. */
function runScript(source: string, dir: string, args: string[] = []) {
  const script = join(dir, `run-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(script, source);
  const child = spawn(process.execPath, [script, ...args], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr!.on("data", (b) => { stderr += b.toString(); });
  cleanups.push(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  return { child, stderr: () => stderr, events: () => stderr.trim().split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as { type: string; [k: string]: unknown }) };
}

/** A helper whose single cycle starts writers and then ignores cancellation, run with `runForeground`. */
function stuckHelperScript(options: { leavingCommand?: string; plainWriter?: string; plainPidFile?: string; listOkFlag?: string }) {
  return `
    import { spawn } from "node:child_process";
    import { existsSync, writeFileSync } from "node:fs";
    import { devNull } from "node:os";
    import { createGitRunner } from ${JSON.stringify(join(src, "git-process.ts"))};
    import { startHelper } from ${JSON.stringify(join(here, "server.ts"))};
    import { runForeground } from ${JSON.stringify(join(here, "cli.ts"))};
    ${options.listOkFlag ? `import { listProcessesSync, sweepSync } from ${JSON.stringify(join(here, "containment.ts"))};` : ""}
    const [repo, rt, gitEnv] = process.argv.slice(2);
    const handle = await startHelper({
      config: { machineId: "own", captureIntervalMs: 1000, vaults: [{ id: "v", path: repo, scope: { include: ["notes"] }, remote: "origin" }] },
      runtimeDir: rt, maxRuntimeMs: 60000, shutdownGraceMs: 50, hardStopMs: 300, engineOptions: { gitEnv: JSON.parse(gitEnv) },
      onEvent: (e) => process.stderr.write(JSON.stringify(e) + "\\n"),
      createEngine: (_vault, options) => ({
        capture: async () => {
          ${options.leavingCommand ? `await createGitRunner({ gitPath: ${JSON.stringify(options.leavingCommand)}, hooksDir: devNull, launch: options.launch }).ok(["status"], { cwd: rt, timeoutMs: 5000, maxOutputBytes: 1000 });` : ""}
          ${options.plainWriter ? `const plain = spawn(process.execPath, [${JSON.stringify(options.plainWriter)}], { stdio: "ignore" }); writeFileSync(${JSON.stringify(options.plainPidFile)}, String(plain.pid));` : ""}
          return new Promise(() => undefined);
        },
        pushBackup: async () => { throw new Error("unused"); },
        verify: async () => { throw new Error("unused"); },
        status: async () => { throw new Error("unused"); },
      }),
    });
    ${options.listOkFlag
      ? `const failing = () => { throw new Error("ps fixture failure: EPERM"); };
    process.exit(await runForeground(handle, { contain: () => sweepSync({ processes: handle.processes, list: existsSync(${JSON.stringify(options.listOkFlag)}) ? listProcessesSync : failing }) }));`
      : `process.exit(await runForeground(handle));`}
  `;
}

describe("the command line keeps its claims until every writer is gone (review R2-1, R2-2, R2-3)", () => {
  test("R2-2: a writer left behind by a Git command that has already closed is killed and confirmed gone before exit 3", async () => {
    const sb = sandbox();
    cleanups.push(() => sb.cleanup());
    const w = writerFixture();
    const rt = join(scratch(), "rt");
    const run = runScript(stuckHelperScript({ leavingCommand: leavingCommand(w) }), w.dir, [sb.repo, rt, JSON.stringify(isolatedGitEnv)]);
    expect(await until(() => existsSync(w.pidFile) && existsSync(w.beat), 10_000)).toBe(true);
    const writer = w.pid();
    expect(listProcessesSync().find((r) => r.pid === writer)?.ppid).toBe(1);
    run.child.kill("SIGTERM");
    const ended = await exited(run.child);
    expect(ended).toEqual({ code: 3, signal: null });
    expect(running(writer)).toBe(false);
    expect(run.events().map((e) => e.type)).toEqual(["started", "stopping", "overdue", "forced-exit"]);
    const overdue = run.events().find((e) => e.type === "overdue")!;
    expect((overdue.processGroups as number[]).length).toBe(1);
  });

  test("R2-1: while the process list cannot be read the command stays alive with its claims held; it exits 3 only once the list works and every child is gone", async () => {
    const sb = sandbox();
    cleanups.push(() => sb.cleanup());
    const recorded = writerFixture("recorded");
    const plain = writerFixture("plain");
    const flag = join(plain.dir, "list-ok");
    const rt = join(scratch(), "rt");
    const run = runScript(stuckHelperScript({ leavingCommand: leavingCommand(recorded), plainWriter: plain.script, plainPidFile: plain.pidFile, listOkFlag: flag }), plain.dir, [sb.repo, rt, JSON.stringify(isolatedGitEnv)]);
    expect(await until(() => existsSync(recorded.pidFile) && existsSync(plain.pidFile) && existsSync(plain.beat), 10_000)).toBe(true);
    const recordedWriter = recorded.pid();
    const plainWriter = plain.pid();
    run.child.kill("SIGTERM");
    expect(await until(() => run.events().some((e) => e.type === "containment-incomplete" && String(e.listError).includes("EPERM")), 5_000)).toBe(true);
    await pause(500);
    // Still running and still the owner: the recorded group was killed, the unrecorded child cannot be found.
    expect(run.child.exitCode).toBeNull();
    expect(running(recordedWriter)).toBe(false);
    expect(running(plainWriter)).toBe(true);
    expect(await plain.beating()).toBe(true);
    expect(tickets(join(rt, "owner.lock")).length).toBe(1);
    await expect(withFolderLock(join(sb.repo, ".git", "vault-sync", "helper-owner"), { waitMs: 0 }, async () => undefined)).rejects.toThrow("holds this checkout's lock");
    writeFileSync(flag, "");
    expect(await exited(run.child)).toEqual({ code: 3, signal: null });
    expect(running(plainWriter)).toBe(false);
    // Only now, with the process gone, do its claims become reclaimable.
    let admitted = false;
    await withFolderLock(join(sb.repo, ".git", "vault-sync", "helper-owner"), { waitMs: 0 }, async () => { admitted = true; });
    expect(admitted).toBe(true);
  });

  test("R2-3: a failed start with work still running is protected from repeated signals until containment confirms", async () => {
    const w = writerFixture();
    const dir = w.dir;
    const claim = join(dir, "claim");
    const flag = join(dir, "contain-ok");
    const config = join(dir, "config.json");
    writeFileSync(config, JSON.stringify({ configVersion: 1, machineId: "own", captureIntervalMs: 60000, vaults: [{ id: "v", path: dir, include: ["notes"], remote: "origin" }] }), { mode: 0o600 });
    const run = runScript(`
      import { mock } from "bun:test";
      import { existsSync, writeFileSync } from "node:fs";
      import { HelperStartError } from ${JSON.stringify(join(here, "server.ts"))};
      import { withFolderLock } from ${JSON.stringify(join(src, "engine-store.ts"))};
      import { sweepSync } from ${JSON.stringify(join(here, "containment.ts"))};
      let registry;
      let writer = 0;
      mock.module(${JSON.stringify(join(here, "server.ts"))}, () => ({
        HelperStartError,
        startHelper: (options) => new Promise((_, reject) => {
          registry = options.processes;
          void withFolderLock(${JSON.stringify(claim)}, { waitMs: 0 }, async () => {
            const child = registry.launch(process.execPath, [${JSON.stringify(w.script)}], { stdio: "ignore" });
            writer = child.pid;
            writeFileSync(${JSON.stringify(w.pidFile)}, String(writer));
            reject(new HelperStartError(new Error("startup fixture"), { state: "overdue", unsettled: [{ vault: "v", work: ["cycle"] }], processGroups: [writer] }, new Promise(() => undefined), registry));
            await new Promise(() => undefined);
          });
        }),
      }));
      const { main } = await import(${JSON.stringify(join(here, "cli.ts"))});
      process.exit(await main(["run", "--config", ${JSON.stringify(config)}, "--runtime-dir", ${JSON.stringify(dir)}, "--max-runtime-ms", "1000"], {
        contain: () => existsSync(${JSON.stringify(flag)}) ? sweepSync({ processes: registry }) : { confirmed: false, killed: [], remaining: [writer] },
      }));
    `, dir);
    expect(await until(() => run.events().some((e) => e.type === "start-failed") && existsSync(w.beat), 10_000), run.stderr()).toBe(true);
    const writer = w.pid();
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP", "SIGTERM"] as const) {
      run.child.kill(signal);
      await pause(50);
    }
    await pause(300);
    expect(run.child.exitCode).toBeNull();
    expect(run.child.signalCode).toBeNull();
    expect(running(writer)).toBe(true);
    await expect(withFolderLock(claim, { waitMs: 0 }, async () => undefined)).rejects.toThrow("holds this checkout's lock");
    expect(run.events().filter((e) => e.type === "signal-ignored").length).toBe(4);
    writeFileSync(flag, "");
    expect(await exited(run.child)).toEqual({ code: 3, signal: null });
    expect(running(writer)).toBe(false);
    let admitted = false;
    await withFolderLock(claim, { waitMs: 0 }, async () => { admitted = true; });
    expect(admitted).toBe(true);
  });

  test("a signal during the start is held and applied as soon as the start completes", async () => {
    const dir = scratch();
    const started = join(dir, "may-start");
    const reasonFile = join(dir, "reason");
    const config = join(dir, "config.json");
    writeFileSync(config, JSON.stringify({ configVersion: 1, machineId: "own", captureIntervalMs: 60000, vaults: [{ id: "v", path: dir, include: ["notes"], remote: "origin" }] }), { mode: 0o600 });
    writeFileSync(join(dir, "booting"), "");
    const run = runScript(`
      import { mock } from "bun:test";
      import { existsSync, writeFileSync } from "node:fs";
      import { HelperStartError } from ${JSON.stringify(join(here, "server.ts"))};
      mock.module(${JSON.stringify(join(here, "server.ts"))}, () => ({
        HelperStartError,
        startHelper: async (options) => {
          process.stderr.write(JSON.stringify({ type: "starting" }) + "\\n");
          while (!existsSync(${JSON.stringify(started)})) await new Promise((r) => setTimeout(r, 20));
          let settle;
          const outcome = new Promise((r) => { settle = r; });
          return {
            socketPath: "", startedAt: 0, outcome, done: outcome.then(() => undefined), processes: options.processes,
            stop: (reason) => { writeFileSync(${JSON.stringify(reasonFile)}, reason); settle({ state: "stopped" }); return outcome; },
          };
        },
      }));
      const { main } = await import(${JSON.stringify(join(here, "cli.ts"))});
      process.exit(await main(["run", "--config", ${JSON.stringify(config)}, "--runtime-dir", ${JSON.stringify(dir)}, "--max-runtime-ms", "1000"]));
    `, dir);
    expect(await until(() => run.events().some((e) => e.type === "starting"), 10_000), run.stderr()).toBe(true);
    run.child.kill("SIGTERM");
    await pause(50);
    run.child.kill("SIGINT");
    await pause(300);
    expect(run.child.exitCode).toBeNull();
    expect(run.child.signalCode).toBeNull();
    writeFileSync(started, "");
    expect(await exited(run.child)).toEqual({ code: 0, signal: null });
    expect(readFileSync(reasonFile, "utf8")).toBe("SIGTERM");
    expect(run.events().map((e) => e.type)).toEqual(["starting", "stop-requested", "signal-ignored"]);
  });
});

describe("containment never lets a reporting or pass error decide the exit", () => {
  const overdueHandle = (): HelperHandle => {
    const outcome = Promise.resolve<StopResult>({ state: "overdue", unsettled: [{ vault: "v", work: ["cycle"] }], processGroups: [] });
    return { socketPath: "", startedAt: 0, outcome, stop: () => outcome, done: new Promise(() => undefined), processes: createProcessRegistry() };
  };

  test("a failing event write and a throwing pass leave containment running until a pass confirms", async () => {
    let passes = 0;
    const code = await runForeground(overdueHandle(), {
      write: () => { throw new Error("EPIPE"); },
      contain: () => {
        passes++;
        if (passes < 3) throw new Error("pass failed");
        return { confirmed: true, killed: [], remaining: [] };
      },
      exit: ((c: number) => c) as never,
    });
    expect(code).toBe(3);
    expect(passes).toBe(3);
  });
});
