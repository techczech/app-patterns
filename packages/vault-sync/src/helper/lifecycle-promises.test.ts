import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
setDefaultTimeout(15_000);
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { connect, Server } from "node:net";
import { lockTestHooks } from "../engine-store.ts";
import { createGitRunner, type ProcessLauncher } from "../git-process.ts";
import * as cli from "./cli.ts";
import { runForeground } from "./cli.ts";
import { connectHelper } from "./client.ts";
import { parseHelperConfig } from "./config.ts";
import { parseHello, parseRequest } from "./protocol.ts";
import type { ContainmentResult } from "./containment.ts";
import type { ProcessRegistry } from "./process-registry.ts";
import { HelperStartError, startHelper, type HelperHandle, type StopResult } from "./server.ts";

// Everything here is in memory: no test starts, inspects or signals a native process. Launchers return
// fake children, and registries are plain objects.

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(): string {
  // Short base: socket paths are limited to 103 bytes.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "vlp-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const flush = async (rounds = 20) => {
  for (let i = 0; i < rounds; i++) await new Promise<void>((r) => setImmediate(r));
};

/** A child with no pid; `kill` counts and closes it on a later turn, as a real one would. */
function fakeChild(onKill: () => void = () => undefined): ChildProcess & EventEmitter {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), { end: () => undefined });
  child.pid = undefined;
  child.kill = () => {
    onKill();
    setImmediate(() => child.emit("close", null, "SIGKILL"));
    return true;
  };
  return child as unknown as ChildProcess & EventEmitter;
}

/** Answers `git rev-parse --absolute-git-dir` with `gitDir`. */
const revParse = (gitDir: string): ProcessLauncher => () => {
  const child = fakeChild();
  setImmediate(() => {
    (child.stdout as EventEmitter).emit("data", Buffer.from(`${gitDir}\n`));
    child.emit("close", 0, null);
  });
  return child;
};

/** A registry double; `end` decides how cleanup goes, and `extra` can replace any other method. */
function memoryRegistry(gitDir: string, end: (call: number) => Promise<void>, extra: Partial<Pick<ProcessRegistry, "launch" | "seal" | "live">> = {}): ProcessRegistry {
  let sealed = false;
  let calls = 0;
  return {
    launch: extra.launch ?? revParse(gitDir),
    seal: extra.seal ?? (() => { sealed = true; }),
    get sealed() { return sealed; },
    live: extra.live ?? (() => []),
    killLive: () => [],
    end: () => { sealed = true; return end(++calls); },
  };
}

const unused = async () => { throw new Error("not used in this test"); };
const engine = () => ({ capture: unused, pushBackup: unused, verify: unused, status: unused }) as never;

async function setup() {
  const vault = tempDir();
  const gitDir = join(vault, ".git");
  mkdirSync(gitDir);
  const cfg = await parseHelperConfig({ configVersion: 1, machineId: "lifecycle-test", captureIntervalMs: 3_600_000, vaults: [{ id: "v", path: vault, include: ["notes"] }] });
  return { cfg, gitDir, runtimeDir: join(tempDir(), "rt") };
}

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const confirmed: ContainmentResult = { confirmed: true, killed: [], remaining: [] };
const unconfirmed: ContainmentResult = { confirmed: false, killed: [], remaining: [42] };

describe("a rejected release keeps the containment interval (static review S1)", () => {
  test("after the release rejects, each further pass waits for its own timer; no pass runs without one", async () => {
    const realSetTimeout = globalThis.setTimeout;
    const pending: Array<() => void> = [];
    globalThis.setTimeout = ((fn: () => void) => { pending.push(fn); return 0; }) as unknown as typeof setTimeout;
    try {
      const outcome = Promise.resolve<StopResult>({ state: "overdue", unsettled: [{ vault: "v", work: ["cycle"] }], processGroups: [] });
      const done = Promise.reject(new Error("cleanup failed"));
      done.catch(() => undefined);
      const inert = { launch: () => { throw new Error("unused"); }, seal: () => undefined, sealed: true, live: () => [], killLive: () => [], end: async () => undefined } as ProcessRegistry;
      const handle: HelperHandle = { socketPath: "", startedAt: 0, outcome, stop: () => outcome, done, processes: inert };
      let passes = 0;
      let finished = false;
      const run = runForeground(handle, {
        write: () => undefined,
        contain: () => (++passes >= 3 ? confirmed : unconfirmed),
        exit: ((c: number) => c) as never,
      }).finally(() => { finished = true; });
      await flush();
      // Before: the rejected release had already fulfilled the wake-up, so all three passes ran at once.
      expect({ passes, timers: pending.length, finished }).toEqual({ passes: 1, timers: 1, finished: false });
      pending.shift()!();
      await flush();
      expect({ passes, timers: pending.length, finished }).toEqual({ passes: 2, timers: 1, finished: false });
      pending.shift()!();
      expect(await run).toBe(3);
      expect(passes).toBe(3);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });
});

describe("failed cleanup is never reported as a release (static review S2)", () => {
  test("control: cleanup that completes gives 'stopped', and `done` fulfils", async () => {
    const { cfg, gitDir, runtimeDir } = await setup();
    const handle = await startHelper({ config: cfg, runtimeDir, maxRuntimeMs: 60_000, shutdownGraceMs: 0, hardStopMs: 50, processes: memoryRegistry(gitDir, async () => undefined), createEngine: engine });
    expect(await handle.stop()).toEqual({ state: "stopped" });
    await expect(handle.done).resolves.toBeUndefined();
  });

  test("a rejected cleanup on a normal stop gives 'failed', `done` rejects, and the command line does not exit 0", async () => {
    const { cfg, gitDir, runtimeDir } = await setup();
    const processes = memoryRegistry(gitDir, (call) => (call === 1 ? Promise.reject(new Error("cleanup failed")) : Promise.resolve()));
    const handle = await startHelper({ config: cfg, runtimeDir, maxRuntimeMs: 60_000, shutdownGraceMs: 0, hardStopMs: 50, processes, createEngine: engine });
    const result = await handle.stop();
    // Before: { state: "stopped" } while `done` rejected.
    expect(result).toMatchObject({ state: "failed", work: "unknown", claims: "held" });
    expect((result as { error: string }).error).toContain("cleanup failed");
    await expect(handle.done).rejects.toThrow("cleanup failed");
    const events: Array<Record<string, unknown>> = [];
    let passes = 0;
    const code = await runForeground(handle, {
      write: (line) => events.push(JSON.parse(line)),
      contain: () => (++passes, confirmed),
      exit: ((c: number) => c) as never,
    });
    expect(code).toBe(3);
    expect(passes).toBe(1);
    expect(events.map((e) => e.type)).toEqual(["stop-failed", "forced-exit"]);
  });

  test("a failed start whose cleanup completes after overdue: `released` fulfils", async () => {
    const { cfg, gitDir, runtimeDir } = await setup();
    const cleanup = deferred();
    const failure = await startHelper({
      config: cfg, runtimeDir, maxRuntimeMs: 60_000, shutdownGraceMs: 0, hardStopMs: 10,
      processes: memoryRegistry(gitDir, (call) => (call === 1 ? cleanup.promise : Promise.resolve())),
      createEngine: () => { throw new Error("engine construction failed"); },
    }).then(() => null, (e: unknown) => e);
    expect(failure).toBeInstanceOf(HelperStartError);
    expect((failure as HelperStartError).shutdown.state).toBe("overdue");
    cleanup.resolve();
    await expect((failure as HelperStartError).released).resolves.toBeUndefined();
  });

  test("a failed start whose cleanup rejects after overdue: `released` rejects with the cleanup failure, not the start error", async () => {
    const { cfg, gitDir, runtimeDir } = await setup();
    const cleanup = deferred();
    const failure = await startHelper({
      config: cfg, runtimeDir, maxRuntimeMs: 60_000, shutdownGraceMs: 0, hardStopMs: 10,
      processes: memoryRegistry(gitDir, (call) => (call === 1 ? cleanup.promise : Promise.resolve())),
      createEngine: () => { throw new Error("engine construction failed"); },
    }).then(() => null, (e: unknown) => e);
    expect(failure).toBeInstanceOf(HelperStartError);
    expect((failure as HelperStartError).shutdown.state).toBe("overdue");
    cleanup.reject(new Error("cleanup failed"));
    // Before: `released` fulfilled whatever the rejection, which the command line takes as a release (exit 0).
    await expect((failure as HelperStartError).released).rejects.toThrow("cleanup failed");
  });
});

describe("Git notices a cancellation made while its launcher runs (static review S3)", () => {
  function counted(signal: AbortSignal) {
    const counts = { added: 0, removed: 0 };
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((...args: Parameters<typeof add>) => { counts.added++; return add(...args); }) as typeof add;
    signal.removeEventListener = ((...args: Parameters<typeof remove>) => { counts.removed++; return remove(...args); }) as typeof remove;
    return counts;
  }

  test("a launcher that cancels before returning ends the run as cancelled, once, with the listener removed", async () => {
    const controller = new AbortController();
    const counts = counted(controller.signal);
    let kills = 0;
    let closes = 0;
    const launch: ProcessLauncher = () => {
      controller.abort();
      const child = fakeChild(() => kills++);
      child.on("close", () => closes++);
      return child;
    };
    const git = createGitRunner({ hooksDir: devNull, launch });
    const t0 = Date.now();
    const failure = await git.run(["status"], { cwd: tempDir(), timeoutMs: 1_500, maxOutputBytes: 1_000, signal: controller.signal }).then(() => null, (e: unknown) => e);
    // Before: the abort was missed and the run ended only at its timeout, as "timeout".
    expect(failure).toMatchObject({ kind: "aborted" });
    expect(Date.now() - t0).toBeLessThan(1_000);
    await flush();
    expect({ kills, closes, ...counts }).toEqual({ kills: 1, closes: 1, added: 1, removed: 1 });
  });

  test("control: an uncancelled run completes normally and removes its listener", async () => {
    const controller = new AbortController();
    const counts = counted(controller.signal);
    const git = createGitRunner({ hooksDir: devNull, launch: revParse("/x/.git") });
    const out = await git.ok(["rev-parse", "--absolute-git-dir"], { cwd: tempDir(), timeoutMs: 1_500, maxOutputBytes: 1_000, signal: controller.signal });
    expect(out.toString("utf8")).toBe("/x/.git\n");
    expect(counts).toEqual({ added: 1, removed: 1 });
  });
});

/** Ticket files in a lock folder: each one is a claim still held. */
function tickets(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith("ticket-")) : [];
}

const within = <T>(promise: Promise<T>, ms: number) => Promise.race([promise.then((v) => ({ settled: "fulfilled" as const, v }), (e: unknown) => ({ settled: "rejected" as const, e })), new Promise<{ settled: "pending" }>((r) => setTimeout(() => r({ settled: "pending" }), ms))]);

/** Restores a mode before the temporary folders are removed (cleanups run last-in, first-out). */
function restoreMode(path: string): void {
  cleanups.push(() => { if (existsSync(path)) chmodSync(path, 0o700); });
}

const ok = async () => undefined;

describe("cleanup results say what shutdown established (review r4, S2-R1)", () => {
  test("the own socket cannot be unlinked: 'failed' with the work ended and the claims released, `done` rejects, exit 3 not 0", async () => {
    const { cfg, gitDir, runtimeDir } = await setup();
    const handle = await startHelper({ config: cfg, runtimeDir, maxRuntimeMs: 60_000, shutdownGraceMs: 0, hardStopMs: 50, processes: memoryRegistry(gitDir, ok), createEngine: engine });
    restoreMode(runtimeDir);
    chmodSync(runtimeDir, 0o500); // the socket's folder refuses the unlink (EACCES)
    const result = await handle.stop();
    // Before: removeOwnSocket swallowed the error, so this was { state: "stopped" } and `done` fulfilled.
    expect(result.state).toBe("failed");
    expect(result).toMatchObject({ work: "ended", socket: "failed", claims: "released" });
    expect(existsSync(handle.socketPath)).toBe(true);
    await expect(handle.done).rejects.toMatchObject({ name: "ShutdownError", report: { work: "ended", socket: "failed", claims: "released" } });
    expect(tickets(join(runtimeDir, "owner.lock"))).toEqual([]);
    const events: Array<Record<string, unknown>> = [];
    const code = await runForeground(handle, { write: (line) => events.push(JSON.parse(line)), contain: () => confirmed, exit: ((c: number) => c) as never });
    expect(code).toBe(3);
    expect(events).toMatchObject([{ type: "stop-failed", socket: "failed" }, { type: "forced-exit", claims: "released" }]);
  });

  test("control: a socket already gone is 'absent', not a failure; the stop is 'stopped'", async () => {
    const { cfg, gitDir, runtimeDir } = await setup();
    const events: string[] = [];
    const handle = await startHelper({ config: cfg, runtimeDir, maxRuntimeMs: 60_000, shutdownGraceMs: 0, hardStopMs: 50, processes: memoryRegistry(gitDir, ok), createEngine: engine, onEvent: (e) => events.push(e.type === "stopped" ? `stopped:${(e as { socket?: string }).socket}` : e.type) });
    unlinkSync(handle.socketPath);
    expect(await handle.stop()).toEqual({ state: "stopped" });
    await expect(handle.done).resolves.toBeUndefined();
    expect(events).not.toContain("shutdown-fault");
  });

  test("control: another file now at the socket path is left in place and is not a failure", async () => {
    const { cfg, gitDir, runtimeDir } = await setup();
    const handle = await startHelper({ config: cfg, runtimeDir, maxRuntimeMs: 60_000, shutdownGraceMs: 0, hardStopMs: 50, processes: memoryRegistry(gitDir, ok), createEngine: engine });
    unlinkSync(handle.socketPath);
    writeFileSync(handle.socketPath, "not the helper's");
    expect(await handle.stop()).toEqual({ state: "stopped" });
    expect(existsSync(handle.socketPath)).toBe(true);
  });

  test("a claim's ticket cannot be removed: 'failed' with the claims held, and `done` rejects", async () => {
    const { cfg, gitDir, runtimeDir } = await setup();
    const handle = await startHelper({ config: cfg, runtimeDir, maxRuntimeMs: 60_000, shutdownGraceMs: 0, hardStopMs: 50, processes: memoryRegistry(gitDir, ok), createEngine: engine });
    const lock = join(runtimeDir, "owner.lock");
    restoreMode(lock);
    chmodSync(lock, 0o500); // the owner ticket cannot be unlinked (EACCES)
    const result = await handle.stop();
    // Before: the lock's `finally` swallowed the failure and this was { state: "stopped" }.
    expect(result.state).toBe("failed");
    expect(result).toMatchObject({ work: "ended", socket: "removed", claims: "held" });
    expect(tickets(lock)).toHaveLength(1);
    await expect(handle.done).rejects.toMatchObject({ name: "ShutdownError", report: { claims: "held" } });
  });
});

describe("a failing seal() or live() never releases the claims before the work ends (review r4, standards)", () => {
  for (const broken of ["seal", "live"] as const) {
    test(`${broken}() throws when the stop is overdue: 'failed' at once, claims held until end() completes`, async () => {
      const { cfg, gitDir, runtimeDir } = await setup();
      const cleanup = deferred();
      const processes = memoryRegistry(gitDir, (call) => (call === 1 ? cleanup.promise : Promise.resolve()), { [broken]: () => { throw new Error(`${broken} failed`); } });
      const handle = await startHelper({ config: cfg, runtimeDir, maxRuntimeMs: 60_000, shutdownGraceMs: 0, hardStopMs: 30, processes, createEngine: engine });
      const result = await handle.stop();
      await flush();
      // Before: the throw left shutdown at once, so the lock callback ended and both tickets were removed
      // while end() was still running.
      expect(tickets(join(runtimeDir, "owner.lock"))).toHaveLength(1);
      expect(tickets(join(gitDir, "vault-sync", "helper-owner"))).toHaveLength(1);
      expect(result).toMatchObject({ state: "failed", work: "unknown", claims: "held" });
      expect(await within(handle.done, 50)).toEqual({ settled: "pending" });
      cleanup.resolve();
      await expect(handle.done).rejects.toMatchObject({ name: "ShutdownError", report: { work: "ended", socket: "removed", claims: "released" } });
      expect(tickets(join(runtimeDir, "owner.lock"))).toEqual([]);
      expect(tickets(join(gitDir, "vault-sync", "helper-owner"))).toEqual([]);
    });
  }
});

describe("every failed start answers readiness within its bound (review r4, S2-R2)", () => {
  const failingStart = (gitDir: string, end: (call: number) => Promise<void>, runtimeDir: string, cfg: Awaited<ReturnType<typeof setup>>["cfg"], extra: Partial<Pick<ProcessRegistry, "launch">> = {}) =>
    startHelper({ config: cfg, runtimeDir, maxRuntimeMs: 60_000, shutdownGraceMs: 0, hardStopMs: 50, processes: memoryRegistry(gitDir, end, extra), createEngine: () => { throw new Error("engine construction failed"); } });

  test("first and second cleanup reject: a HelperStartError 'failed' with the claims held; `released` rejects once end() succeeds", async () => {
    const { cfg, gitDir, runtimeDir } = await setup();
    const answer = await within(failingStart(gitDir, (call) => (call <= 2 ? Promise.reject(new Error(`cleanup failed ${call}`)) : Promise.resolve()), runtimeDir, cfg), 2_000);
    // Before: the second rejection left the outer catch before rejectReady, so the start never answered.
    expect(answer.settled).toBe("rejected");
    const failure = (answer as { e: unknown }).e as HelperStartError;
    expect(failure).toBeInstanceOf(HelperStartError);
    expect(failure.message).toBe("engine construction failed");
    expect(failure.shutdown).toMatchObject({ state: "failed", work: "unknown", claims: "held" });
    await expect(failure.released).rejects.toMatchObject({ name: "ShutdownError", report: { work: "ended", claims: "released" } });
    expect(tickets(join(runtimeDir, "owner.lock"))).toEqual([]);
  });

  test("first cleanup rejects, the retry succeeds: a HelperStartError the command line contains (exit 3), not a raw error (exit 2)", async () => {
    const { cfg, gitDir, runtimeDir } = await setup();
    const failure = await failingStart(gitDir, (call) => (call === 1 ? Promise.reject(new Error("cleanup failed")) : Promise.resolve()), runtimeDir, cfg).then(() => null, (e: unknown) => e);
    // Before: readiness rejected with the raw "cleanup failed", which the command line rethrows as exit 2.
    expect(failure).toBeInstanceOf(HelperStartError);
    expect((failure as HelperStartError).shutdown.state).toBe("failed");
    await expect((failure as HelperStartError).released).rejects.toMatchObject({ name: "ShutdownError" });
    const code = await cli.containFailedStart(failure, (failure as HelperStartError).processes!, { write: () => undefined, contain: () => confirmed, exit: ((c: number) => c) as never });
    expect(code).toBe(3);
  });

  test("cleanup rejects, then never ends: readiness still answers at once; `released` stays pending", async () => {
    const { cfg, gitDir, runtimeDir } = await setup();
    const answer = await within(failingStart(gitDir, (call) => (call === 1 ? Promise.reject(new Error("cleanup failed")) : new Promise<void>(() => undefined)), runtimeDir, cfg), 2_000);
    // Before: the outer catch awaited the never-ending second end() before answering.
    expect(answer.settled).toBe("rejected");
    const failure = (answer as { e: unknown }).e as HelperStartError;
    expect(failure.shutdown).toMatchObject({ state: "failed", work: "unknown", claims: "held" });
    expect(await within(failure.released, 100)).toEqual({ settled: "pending" });
    expect(tickets(join(runtimeDir, "owner.lock"))).toHaveLength(1);
  });

  test("a refused start whose cleanup never ends answers 'overdue' within grace + hard stop", async () => {
    const { cfg, gitDir, runtimeDir } = await setup();
    const failedLookup: ProcessLauncher = () => {
      const child = fakeChild();
      setImmediate(() => child.emit("close", 128, null));
      return child;
    };
    const answer = await within(failingStart(gitDir, () => new Promise<void>(() => undefined), runtimeDir, cfg, { launch: failedLookup }), 2_000);
    // Before: the lookup failure awaited end() with no bound, so the start never answered.
    expect(answer.settled).toBe("rejected");
    const failure = (answer as { e: unknown }).e as HelperStartError;
    expect(failure).toBeInstanceOf(HelperStartError);
    expect(failure.shutdown).toEqual({ state: "overdue", unsettled: [], processGroups: [] });
    expect(await within(failure.released, 100)).toEqual({ settled: "pending" });
  });

  test("control: a failed start whose cleanup succeeds rejects with its own error, 'stopped', and `released` fulfils", async () => {
    const { cfg, gitDir, runtimeDir } = await setup();
    const failure = await failingStart(gitDir, ok, runtimeDir, cfg).then(() => null, (e: unknown) => e);
    expect(failure).toBeInstanceOf(HelperStartError);
    expect(failure).toMatchObject({ message: "engine construction failed", shutdown: { state: "stopped" } });
    await expect((failure as HelperStartError).released).resolves.toBeUndefined();
    expect(tickets(join(runtimeDir, "owner.lock"))).toEqual([]);
    expect(tickets(join(gitDir, "vault-sync", "helper-owner"))).toEqual([]);
  });

  test("control: a refused start whose cleanup succeeds rejects with the plain error", async () => {
    const { cfg, gitDir, runtimeDir } = await setup();
    const failedLookup: ProcessLauncher = () => {
      const child = fakeChild();
      setImmediate(() => child.emit("close", 128, null));
      return child;
    };
    const failure = await failingStart(gitDir, ok, runtimeDir, cfg, { launch: failedLookup }).then(() => null, (e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(HelperStartError);
  });
});

describe("a claim left by a failed lock acquisition is never certified released (review r5, R5-1)", () => {
  /** Makes `dir` unwritable just after a contender there took its ticket: neither file can be removed. */
  const blockAcquisitionIn = (dir: string) => {
    cleanups.push(() => { lockTestHooks.beforeWithdraw = undefined; });
    restoreMode(dir);
    lockTestHooks.beforeWithdraw = (lockDir) => { if (lockDir === dir) chmodSync(dir, 0o500); };
  };
  const files = (dir: string, kind: string) => readdirSync(dir).filter((n) => n.startsWith(`${kind}-`));

  for (const where of ["owner", "vault"] as const) {
    test(`the ${where} lock's announcement cannot be withdrawn: a HelperStartError 'failed' with the claims held, contained (exit 3)`, async () => {
      const { cfg, gitDir, runtimeDir } = await setup();
      const ownerLock = join(runtimeDir, "owner.lock");
      const vaultLock = join(gitDir, "vault-sync", "helper-owner");
      const blocked = where === "owner" ? ownerLock : vaultLock;
      blockAcquisitionIn(blocked);
      let workerStarted = false;
      const failure = await startHelper({ config: cfg, runtimeDir, maxRuntimeMs: 60_000, shutdownGraceMs: 0, hardStopMs: 50, processes: memoryRegistry(gitDir, ok), createEngine: () => { workerStarted = true; return engine(); } }).then(() => null, (e: unknown) => e);
      // Before: the withdrawal error bypassed the listener, the start was refused with the plain error
      // (exit 2) and its cleanup counted as clean, although both files stayed.
      expect(failure).toBeInstanceOf(HelperStartError);
      const start = failure as HelperStartError;
      expect(start.shutdown).toMatchObject({ state: "failed", work: "ended", socket: "not-created", claims: "held" });
      await expect(start.released).rejects.toMatchObject({ name: "ShutdownError", report: { work: "ended", claims: "held" } });
      expect(workerStarted).toBe(false);
      chmodSync(blocked, 0o700);
      expect(files(blocked, "choosing")).toHaveLength(1);
      expect(files(blocked, "ticket")).toHaveLength(1);
      if (where === "vault") expect(tickets(ownerLock)).toEqual([]);
      const events: Array<Record<string, unknown>> = [];
      const code = await cli.containFailedStart(start, start.processes!, { write: (line) => events.push(JSON.parse(line)), contain: () => confirmed, exit: ((c: number) => c) as never });
      expect(code).toBe(3);
      expect(events).toMatchObject([{ type: "start-failed", shutdown: "failed", claims: "held" }, { type: "forced-exit", claims: "held until this process is gone" }]);
    });
  }
});

describe("a claim file whose creation rejected after it was made is never certified released (review r6, R6-1)", () => {
  /** In `dir` only, the real exclusive creation of the `kind` file runs, then the operation rejects. */
  const failAfterCreatingIn = (dir: string, kind: "choosing" | "ticket") => {
    cleanups.push(() => { lockTestHooks.createFile = undefined; });
    lockTestHooks.createFile = async (path) => {
      writeFileSync(path, "", { flag: "wx" });
      if (path.startsWith(`${dir}/${kind}-`)) throw Object.assign(new Error("EIO: i/o error, close"), { code: "EIO" });
    };
  };
  const files = (dir: string, kind: string) => readdirSync(dir).filter((n) => n.startsWith(`${kind}-`));

  for (const where of ["owner", "vault"] as const) {
    for (const kind of ["choosing", "ticket"] as const) {
      test(`the ${where} lock's ${kind} file: a HelperStartError 'failed' with the claims held, released rejects, contained (exit 3)`, async () => {
        const { cfg, gitDir, runtimeDir } = await setup();
        const ownerLock = join(runtimeDir, "owner.lock");
        const vaultLock = join(gitDir, "vault-sync", "helper-owner");
        const failing = where === "owner" ? ownerLock : vaultLock;
        failAfterCreatingIn(failing, kind);
        let workerStarted = false;
        const failure = await startHelper({ config: cfg, runtimeDir, maxRuntimeMs: 60_000, shutdownGraceMs: 0, hardStopMs: 50, processes: memoryRegistry(gitDir, ok), createEngine: () => { workerStarted = true; return engine(); } }).then(() => null, (e: unknown) => e);
        // Before: no report reached the listener, the start was refused with the plain error (exit 2) and the
        // claims counted as released, although the created file stayed.
        expect(failure).toBeInstanceOf(HelperStartError);
        const start = failure as HelperStartError;
        expect(start.shutdown).toMatchObject({ state: "failed", work: "ended", socket: "not-created", claims: "held" });
        await expect(start.released).rejects.toMatchObject({ name: "ShutdownError", report: { work: "ended", claims: "held" } });
        expect(workerStarted).toBe(false);
        expect(files(failing, kind)).toHaveLength(1);
        if (where === "vault") expect(tickets(ownerLock)).toEqual([]);
        const events: Array<Record<string, unknown>> = [];
        const code = await cli.containFailedStart(start, start.processes!, { write: (line) => events.push(JSON.parse(line)), contain: () => confirmed, exit: ((c: number) => c) as never });
        expect(code).toBe(3);
        expect(events).toMatchObject([{ type: "start-failed", shutdown: "failed", claims: "held" }, { type: "forced-exit", claims: "held until this process is gone" }]);
      });
    }
  }
});

describe("the 'stopped' event comes only after a clean conclusion (review r5, R5-2)", () => {
  test("clean stop: 'stopped' is the last event and comes after every ticket is gone", async () => {
    const { cfg, gitDir, runtimeDir } = await setup();
    const seen: Array<{ type: string; owner: number; vault: number }> = [];
    const handle = await startHelper({ config: cfg, runtimeDir, maxRuntimeMs: 60_000, shutdownGraceMs: 0, hardStopMs: 50, processes: memoryRegistry(gitDir, ok), createEngine: engine, onEvent: (e) => seen.push({ type: e.type, owner: tickets(join(runtimeDir, "owner.lock")).length, vault: tickets(join(gitDir, "vault-sync", "helper-owner")).length }) });
    expect(await handle.stop()).toEqual({ state: "stopped" });
    await handle.done;
    // Before: 'stopped' was emitted inside the claims, with both tickets still present.
    expect(seen.at(-1)).toEqual({ type: "stopped", owner: 0, vault: 0 });
    expect(seen.filter((e) => e.type === "stopped")).toHaveLength(1);
  });

  test("socket removal fails: no 'stopped' event; the fault is reported and the result is 'failed'", async () => {
    const { cfg, gitDir, runtimeDir } = await setup();
    const events: string[] = [];
    const handle = await startHelper({ config: cfg, runtimeDir, maxRuntimeMs: 60_000, shutdownGraceMs: 0, hardStopMs: 50, processes: memoryRegistry(gitDir, ok), createEngine: engine, onEvent: (e) => events.push(e.type) });
    restoreMode(runtimeDir);
    chmodSync(runtimeDir, 0o500);
    expect((await handle.stop()).state).toBe("failed");
    await handle.done.catch(() => undefined);
    // Before: 'stopped' followed the socket fault.
    expect(events).toContain("shutdown-fault");
    expect(events).not.toContain("stopped");
  });

  test("a claim's ticket cannot be removed: no 'stopped' event; the result is 'failed' with the claims held", async () => {
    const { cfg, gitDir, runtimeDir } = await setup();
    const events: string[] = [];
    const handle = await startHelper({ config: cfg, runtimeDir, maxRuntimeMs: 60_000, shutdownGraceMs: 0, hardStopMs: 50, processes: memoryRegistry(gitDir, ok), createEngine: engine, onEvent: (e) => events.push(e.type) });
    const lock = join(runtimeDir, "owner.lock");
    restoreMode(lock);
    chmodSync(lock, 0o500);
    expect(await handle.stop()).toMatchObject({ state: "failed", claims: "held" });
    await handle.done.catch(() => undefined);
    // Before: 'stopped' (socket removed) was emitted before the owner ticket's removal was attempted.
    expect(events.at(-1)).toBe("shutdown-fault");
    expect(events).not.toContain("stopped");
  });
});

describe("progress events state the same claims as the terminal event (review r5, R5-3)", () => {
  const failedStart = (claims: "released" | "held") => new HelperStartError(new Error("start failed"), { state: "failed", error: "socket removal: refused", work: "ended", socket: "failed", claims }, new Promise<void>(() => undefined));
  const passes = (): (() => ContainmentResult) => {
    let n = 0;
    return () => (++n === 1 ? { confirmed: false, killed: [], remaining: [], listError: "process list failed" } : confirmed);
  };

  for (const claims of ["released", "held"] as const) {
    test(`claims ${claims}: 'containment-incomplete' and 'forced-exit' agree`, async () => {
      const events: Array<Record<string, unknown>> = [];
      const fallback = memoryRegistry("/unused", ok);
      const code = await cli.containFailedStart(failedStart(claims), fallback, { write: (line) => events.push(JSON.parse(line)), contain: passes(), exit: ((c: number) => c) as never });
      expect(code).toBe(3);
      const incomplete = events.find((e) => e.type === "containment-incomplete");
      const forced = events.find((e) => e.type === "forced-exit");
      // Before: 'containment-incomplete' always said "held", even when the release was established.
      expect(incomplete?.claims).toBe(forced?.claims);
      expect(forced?.claims).toBe(claims === "released" ? "released" : "held until this process is gone");
    });
  }
});

/**
 * Hands every server the helper creates to the test. `mode` "after-listen" emits `error` on the server just
 * after its listen callback (the start has not completed); "listen-fails" emits it instead of listening.
 */
function captureServers(mode: "plain" | "after-listen" | "listen-fails" = "plain", error: Error = new Error("injected server error")): Server[] {
  const original = Server.prototype.listen;
  const servers: Server[] = [];
  Server.prototype.listen = function (this: Server, ...args: unknown[]) {
    servers.push(this);
    if (mode === "listen-fails") {
      setImmediate(() => this.emit("error", error));
      return this;
    }
    if (mode === "after-listen") {
      const cb = args.pop() as () => void;
      args.push(() => {
        cb();
        this.emit("error", error);
      });
    }
    return (original as (...a: unknown[]) => Server).apply(this, args);
  } as typeof original;
  cleanups.push(() => { Server.prototype.listen = original; });
  return servers;
}

const emfile = () => Object.assign(new Error("accept EMFILE"), { code: "EMFILE" });

describe("a socket server error is never unhandled and stops the helper through its ordinary shutdown (review r8, R8-1)", () => {
  test("after listen, with a cycle still running: no throw; 'failed' only once the work ended; claims held until then; contained, exit 3", async () => {
    const { cfg, gitDir, runtimeDir } = await setup();
    const servers = captureServers();
    const hold = deferred();
    let capturing = false;
    const events: Array<{ type: string; reason?: unknown; fault?: unknown }> = [];
    const handle = await startHelper({
      config: cfg, runtimeDir, maxRuntimeMs: 60_000, shutdownGraceMs: 0, hardStopMs: 5_000, processes: memoryRegistry(gitDir, ok),
      createEngine: () => ({ capture: async () => { capturing = true; await hold.promise; throw new Error("cycle ended"); }, pushBackup: unused, verify: unused, status: unused }) as never,
      onEvent: (e) => events.push({ type: e.type, reason: (e as { reason?: unknown }).reason, fault: (e as { fault?: unknown }).fault }),
    });
    cleanups.push(() => hold.resolve());
    expect(servers).toHaveLength(1);
    const client = await connectHelper(handle.socketPath, { client: "test" });
    cleanups.push(() => client.close());
    const sync = client.request("syncNow", { vault: "v" }, 10_000).catch((e: unknown) => e);
    for (let i = 0; i < 200 && !capturing; i++) await new Promise((r) => setTimeout(r, 5));
    expect(capturing).toBe(true);
    // Before: no listener after listen, so emit() threw ERR_UNHANDLED_ERROR (in the process: a crash with no shutdown).
    expect(() => servers[0]!.emit("error", emfile())).not.toThrow();
    expect(() => servers[0]!.emit("error", emfile())).not.toThrow();
    await flush();
    expect(events.filter((e) => e.type === "shutdown-fault")).toEqual([{ type: "shutdown-fault", reason: undefined, fault: "socket server: accept EMFILE" }]);
    expect(events.find((e) => e.type === "stopping")?.reason).toBe("server-error");
    // The cycle has not ended: no answer yet, and both claims are still held.
    expect(await within(handle.outcome, 100)).toEqual({ settled: "pending" });
    expect(await within(handle.done, 0)).toEqual({ settled: "pending" });
    expect(tickets(join(runtimeDir, "owner.lock"))).toHaveLength(1);
    expect(tickets(join(gitDir, "vault-sync", "helper-owner"))).toHaveLength(1);
    hold.resolve();
    const result = await handle.outcome;
    expect(result).toMatchObject({ state: "failed", work: "ended", socket: "removed", claims: "released" });
    expect((result as { error: string }).error).toContain("socket server: accept EMFILE");
    await expect(handle.done).rejects.toMatchObject({ name: "ShutdownError", report: { work: "ended", claims: "released" } });
    expect(tickets(join(runtimeDir, "owner.lock"))).toEqual([]);
    expect(tickets(join(gitDir, "vault-sync", "helper-owner"))).toEqual([]);
    // The running cycle was cancelled by the stop and answered before the connection closed.
    expect(await sync).toMatchObject({ ok: true, result: { outcome: "cancelled" } });
    expect(events.map((e) => e.type)).not.toContain("stopped");
    // The stop request the error made and a later one share one answer.
    expect(await handle.stop("again")).toBe(result);
    const out: Array<Record<string, unknown>> = [];
    const code = await runForeground(handle, { write: (line) => out.push(JSON.parse(line)), contain: () => confirmed, exit: ((c: number) => c) as never });
    expect(code).toBe(3);
    expect(out.map((e) => e.type)).toEqual(["stop-failed", "forced-exit"]);
    expect(out[1]!.claims).toBe("released");
  });

  test("after listen but before the start completed: the start fails with that error through its ordinary cleanup ('stopped', exit 2 path)", async () => {
    const { cfg, gitDir, runtimeDir } = await setup();
    captureServers("after-listen", emfile());
    const events: string[] = [];
    const failure = await startHelper({ config: cfg, runtimeDir, maxRuntimeMs: 60_000, shutdownGraceMs: 0, hardStopMs: 50, processes: memoryRegistry(gitDir, ok), createEngine: engine, onEvent: (e) => events.push(e.type) }).then(() => null, (e: unknown) => e);
    // Before: the error was emitted with no listener, out of the listen callback.
    expect(failure).toBeInstanceOf(HelperStartError);
    expect(failure).toMatchObject({ message: "accept EMFILE", code: "EMFILE", shutdown: { state: "stopped" } });
    await expect((failure as HelperStartError).released).resolves.toBeUndefined();
    expect(events).toEqual(["stopping", "start-cleaned-up"]);
    expect(tickets(join(runtimeDir, "owner.lock"))).toEqual([]);
    expect(tickets(join(gitDir, "vault-sync", "helper-owner"))).toEqual([]);
    expect(existsSync(join(runtimeDir, "helper.sock"))).toBe(false);
    expect(await cli.containFailedStart(failure, (failure as HelperStartError).processes!, { write: () => undefined, contain: () => confirmed, exit: ((c: number) => c) as never })).toBeNull();
  });

  test("control: listen itself fails: a start failure with nothing bound, cleaned up ('stopped')", async () => {
    const { cfg, gitDir, runtimeDir } = await setup();
    captureServers("listen-fails", Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" }));
    const events: string[] = [];
    const failure = await startHelper({ config: cfg, runtimeDir, maxRuntimeMs: 60_000, shutdownGraceMs: 0, hardStopMs: 50, processes: memoryRegistry(gitDir, ok), createEngine: engine, onEvent: (e) => events.push(e.type) }).then(() => null, (e: unknown) => e);
    expect(failure).toBeInstanceOf(HelperStartError);
    expect(failure).toMatchObject({ message: "listen EADDRINUSE", code: "EADDRINUSE", shutdown: { state: "stopped" } });
    await expect((failure as HelperStartError).released).resolves.toBeUndefined();
    expect(events).toEqual(["stopping", "start-cleaned-up"]);
    expect(tickets(join(runtimeDir, "owner.lock"))).toEqual([]);
  });

  test("control: a helper with no server error still stops cleanly with 'stopped'", async () => {
    const { cfg, gitDir, runtimeDir } = await setup();
    captureServers();
    const events: string[] = [];
    const handle = await startHelper({ config: cfg, runtimeDir, maxRuntimeMs: 60_000, shutdownGraceMs: 0, hardStopMs: 50, processes: memoryRegistry(gitDir, ok), createEngine: engine, onEvent: (e) => events.push(e.type) });
    expect(await handle.stop()).toEqual({ state: "stopped" });
    await handle.done;
    expect(events).toEqual(["started", "stopping", "stopped"]);
  });
});

describe("a failed start is never announced as a stop or exit 0 (review r8, R8-2)", () => {
  test("a failed start whose cleanup is clean ends with 'start-cleaned-up', never 'stopped'", async () => {
    const { cfg, gitDir, runtimeDir } = await setup();
    const events: string[] = [];
    const failure = await startHelper({ config: cfg, runtimeDir, maxRuntimeMs: 60_000, shutdownGraceMs: 0, hardStopMs: 50, processes: memoryRegistry(gitDir, ok), createEngine: () => { throw new Error("engine construction failed"); }, onEvent: (e) => events.push(e.type) }).then(() => null, (e: unknown) => e);
    expect(failure).toMatchObject({ shutdown: { state: "stopped" } });
    // Before: ["stopping", "stopped"] for a helper that never started.
    expect(events).toEqual(["stopping", "start-cleaned-up"]);
  });

  test("a failed start contained after 'overdue' whose work then ends cleanly exits 2, not 0", async () => {
    const { cfg, gitDir, runtimeDir } = await setup();
    const cleanup = deferred();
    const failure = await startHelper({
      config: cfg, runtimeDir, maxRuntimeMs: 60_000, shutdownGraceMs: 0, hardStopMs: 10,
      processes: memoryRegistry(gitDir, (call) => (call === 1 ? cleanup.promise : Promise.resolve())),
      createEngine: () => { throw new Error("engine construction failed"); },
    }).then(() => null, (e: unknown) => e);
    expect((failure as HelperStartError).shutdown.state).toBe("overdue");
    const out: string[] = [];
    let passes = 0;
    const code = cli.containFailedStart(failure, (failure as HelperStartError).processes!, { write: (line) => out.push(JSON.parse(line).type), contain: () => (++passes, unconfirmed), exit: ((c: number) => c) as never });
    await flush();
    cleanup.resolve();
    // Before: 0, the code of a started helper that stopped cleanly.
    expect(await code).toBe(2);
    expect(passes).toBeGreaterThan(0);
    expect(out[0]).toBe("start-failed");
    expect(out).not.toContain("forced-exit");
  });

  test("control: a started helper contained after 'overdue' whose work then ends cleanly still exits 0", async () => {
    let finish!: () => void;
    const done = new Promise<void>((r) => { finish = r; });
    const outcome = Promise.resolve<StopResult>({ state: "overdue", unsettled: [{ vault: "v", work: ["cycle"] }], processGroups: [] });
    const handle: HelperHandle = { socketPath: "", startedAt: 0, outcome, stop: () => outcome, done, processes: memoryRegistry("/unused", ok) };
    const code = runForeground(handle, { write: () => undefined, contain: () => unconfirmed, exit: ((c: number) => c) as never });
    await flush();
    finish();
    expect(await code).toBe(0);
  });

  test("control: a failed start confirmed by containment still exits 3", async () => {
    const failure = new HelperStartError(new Error("start failed"), { state: "overdue", unsettled: [], processGroups: [] }, new Promise<void>(() => undefined));
    expect(await cli.containFailedStart(failure, memoryRegistry("/unused", ok), { write: () => undefined, contain: () => confirmed, exit: ((c: number) => c) as never })).toBe(3);
  });
});

describe("the protocol header matches what each side checks (review r8, R8-3)", () => {
  test("hello: extra fields are ignored; the required fields are checked", () => {
    expect(parseHello(JSON.stringify({ type: "hello", protocol: 1, client: "c", extra: true }))).toEqual({ type: "hello", protocol: 1, client: "c" });
    expect(() => parseHello(JSON.stringify({ type: "hello", protocol: "1", client: "c" }))).toThrow("integer protocol");
  });

  test("request: an unknown field is a bad-request for that id", () => {
    expect(() => parseRequest(JSON.stringify({ id: 4, method: "status", path: "/x" }))).toThrow(expect.objectContaining({ code: "bad-request", id: 4 }));
  });

  test("over the socket: an unknown request field is answered and the connection stays open; a bad hello closes it", async () => {
    const { cfg, gitDir, runtimeDir } = await setup();
    const handle = await startHelper({ config: cfg, runtimeDir, maxRuntimeMs: 60_000, shutdownGraceMs: 0, hardStopMs: 50, processes: memoryRegistry(gitDir, ok), createEngine: engine });
    cleanups.push(() => void handle.stop());
    const talk = (lines: string[], replies: number) => new Promise<{ replies: Array<Record<string, unknown>>; closed: boolean }>((resolve) => {
      const got: Array<Record<string, unknown>> = [];
      let buffer = "";
      let closed = false;
      const socket = connect(handle.socketPath);
      const finish = () => resolve({ replies: got, get closed() { return closed; } });
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
          got.push(JSON.parse(buffer.slice(0, i)));
          buffer = buffer.slice(i + 1);
        }
        // Still open 50 ms after the last expected reply: record that, then close from this side.
        if (got.length >= replies) setTimeout(() => { const wasClosed = closed; finish(); if (!wasClosed) socket.destroy(); }, 50);
      });
      socket.on("close", () => { closed = true; finish(); });
      socket.on("error", () => undefined);
      socket.on("connect", () => { for (const line of lines) socket.write(`${line}\n`); });
    });
    const open = await talk([
      JSON.stringify({ type: "hello", protocol: 1, client: "t", extra: 1 }),
      JSON.stringify({ id: 1, method: "status", path: "/x" }),
      JSON.stringify({ id: 2, method: "syncNow", vault: "nope" }),
    ], 3);
    const openAtCheck = open.closed;
    expect(open.replies[0]).toMatchObject({ type: "hello", ok: true });
    expect(open.replies[1]).toMatchObject({ id: 1, ok: false, error: { code: "bad-request" } });
    expect(open.replies[2]).toMatchObject({ id: 2, ok: false, error: { code: "unknown-vault" } });
    expect(openAtCheck).toBe(false);
    const refused = await talk([JSON.stringify({ type: "hello", protocol: 2, client: "t" })], 1);
    expect(refused.replies[0]).toMatchObject({ type: "hello", ok: false, error: { code: "protocol-mismatch" } });
    await new Promise((r) => setTimeout(r, 100));
    expect(refused.closed).toBe(true);
    expect(await handle.stop()).toEqual({ state: "stopped" });
  });
});
