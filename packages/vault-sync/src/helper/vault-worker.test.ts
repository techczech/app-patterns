import { describe, expect, test } from "bun:test";
import { BackupRefusedError } from "../blocks.ts";
import type { BackupStatus, CaptureResult, PushResult, VerifyResult } from "../engine.ts";
import { createVaultWorker, type Clock, type Timers, type VaultWorkerOptions } from "./vault-worker.ts";

/** Controllable clocks: `advance` moves both; `sleep` moves only the wall clock, as a machine asleep does. */
function fakeTime(start = 1_800_000_000_000) {
  let wall = start;
  let mono = 0;
  let nextId = 1;
  const pending = new Map<number, { fn: () => void; at: number }>();
  const clock: Clock = { now: () => wall, monotonic: () => mono };
  const timers: Timers = {
    set: (fn, ms) => {
      const id = nextId++;
      pending.set(id, { fn, at: mono + Math.max(0, ms) });
      return id;
    },
    clear: (id) => void pending.delete(id as number),
  };
  const fireDue = async () => {
    for (;;) {
      const due = [...pending.entries()].filter(([, t]) => t.at <= mono).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      pending.delete(due[0]);
      due[1].fn();
      await settle();
    }
  };
  return {
    clock,
    timers,
    pending,
    async advance(ms: number, step = 250) {
      for (let done = 0; done < ms; done += step) {
        const d = Math.min(step, ms - done);
        wall += d;
        mono += d;
        await fireDue();
      }
      await settle();
    },
    sleep(ms: number) {
      wall += ms;
    },
    setWall(ms: number) {
      wall = ms;
    },
    get wall() {
      return wall;
    },
  };
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
};

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const vault = { id: "fixture", path: "/disposable/fixture", scope: { include: ["notes"] }, remote: "origin" };

function capture(snapshot: string | null, startedAt: number): CaptureResult {
  return { committed: true, snapshot, ref: snapshot ? "refs/heads/backup/m/c/2027-01-15" : null, startedAt, added: [], modified: ["notes/a.md"], removed: [], pending: [], skipped: [] };
}

function status(overrides: Partial<BackupStatus> = {}): BackupStatus {
  return {
    machineId: "m", checkoutId: "c", protectionAgeSeconds: 0, oldestUnprotectedEdit: null, lastVerifiedSnapshot: "s1", lastVerifiedAt: 1, protectedThrough: 1,
    latestSnapshot: "s1", latestRef: "r", lastPushed: null, pending: [], unlistedFolders: [], unflushedEditSince: null, writing: [], lastError: null,
    recoveredFromDamagedRecord: false, repositoryHooksNotRun: [], enabled: true, remote: "origin", block: null, ...overrides,
  };
}

/** Engine double recording each call and the largest number of overlapping cycles. */
function fakeEngine(time: ReturnType<typeof fakeTime>) {
  const calls: string[] = [];
  let active = 0;
  let maxActive = 0;
  let n = 0;
  const engine = {
    calls,
    get maxActive() { return maxActive; },
    gate: null as null | Promise<void>,
    signals: [] as AbortSignal[],
    push: (snapshot: string): PushResult => ({ state: "pushed", ref: "r", snapshot, notScanned: [] }),
    verify: (snapshot: string): VerifyResult => ({ verified: true, ref: "r", snapshot }),
    statusValue: (): Promise<BackupStatus> => Promise.resolve(status()),
    last: "",
    api: {
      capture: async (_repo: string, _scope: unknown, opts?: { signal?: AbortSignal }) => {
        active++;
        maxActive = Math.max(maxActive, active);
        calls.push(`capture@${time.wall}`);
        if (opts?.signal) engine.signals.push(opts.signal);
        try {
          if (engine.gate) await engine.gate;
          engine.last = `s${++n}`;
          return capture(engine.last, time.wall);
        } finally {
          active--;
        }
      },
      pushBackup: async () => { calls.push("push"); return engine.push(engine.last); },
      verify: async () => { calls.push("verify"); return engine.verify(engine.last); },
      status: async () => engine.statusValue(),
    },
  };
  return engine;
}

function worker(time: ReturnType<typeof fakeTime>, engine: ReturnType<typeof fakeEngine>, extra: Partial<VaultWorkerOptions> = {}) {
  const reports: string[] = [];
  const w = createVaultWorker({ vault, engine: engine.api, intervalMs: 60_000, clock: time.clock, timers: time.timers, pollMs: 5_000, statusTimeoutMs: 1_000, onCycle: (r) => reports.push(r.outcome), ...extra });
  return { w, reports };
}

describe("vault worker cadence", () => {
  test("runs on an absolute cadence anchored at start", async () => {
    const time = fakeTime();
    const engine = fakeEngine(time);
    const { w, reports } = worker(time, engine);
    const start = time.wall;
    w.start();
    await time.advance(59_000);
    expect(reports).toEqual([]);
    await time.advance(181_000);
    expect(reports).toEqual(["verified", "verified", "verified", "verified"]);
    expect(engine.calls.filter((c) => c.startsWith("capture")).map((c) => Number(c.split("@")[1]) - start)).toEqual([60_000, 120_000, 180_000, 240_000]);
    await w.stop(1_000);
  });

  test("a wake after sleep runs one cycle, then skips the missed slots", async () => {
    const time = fakeTime();
    const engine = fakeEngine(time);
    const { w, reports } = worker(time, engine);
    const start = time.wall;
    w.start();
    await time.advance(60_000);
    expect(reports.length).toBe(1);
    // Ten intervals pass on the wall clock while monotonic time (and every timer) is frozen.
    time.sleep(600_000);
    await time.advance(5_000);
    expect(reports.length).toBe(2);
    const second = Number(engine.calls.filter((c) => c.startsWith("capture"))[1]!.split("@")[1]);
    expect(second - start).toBe(665_000);
    // The next cycle is the next absolute slot (720 s), not a catch-up burst.
    await time.advance(50_000);
    expect(reports.length).toBe(2);
    await time.advance(5_000);
    expect(reports.length).toBe(3);
    expect(engine.maxActive).toBe(1);
    await w.stop(1_000);
  });

  test("a backward wall-clock jump keeps the cadence through the monotonic fallback", async () => {
    const time = fakeTime();
    const engine = fakeEngine(time);
    const { w, reports } = worker(time, engine);
    w.start();
    await time.advance(60_000);
    time.setWall(time.wall - 3_600_000);
    await time.advance(60_000);
    expect(reports.length).toBe(2);
    await w.stop(1_000);
  });

  test("never overlaps cycles: a slow cycle across many due times and a wake stays single", async () => {
    const time = fakeTime();
    const engine = fakeEngine(time);
    const gate = deferred();
    engine.gate = gate.promise;
    const { w, reports } = worker(time, engine);
    w.start();
    await time.advance(60_000);
    time.sleep(900_000);
    await time.advance(600_000);
    expect(engine.calls.filter((c) => c.startsWith("capture")).length).toBe(1);
    expect(time.pending.size).toBe(0);
    engine.gate = null;
    gate.resolve();
    await settle();
    expect(reports).toEqual(["verified"]);
    expect(time.pending.size).toBe(1);
    expect(engine.maxActive).toBe(1);
    await w.stop(1_000);
  });
});

describe("syncNow", () => {
  test("runs immediately when idle and resets nothing about the absolute slots", async () => {
    const time = fakeTime();
    const engine = fakeEngine(time);
    const { w } = worker(time, engine);
    w.start();
    await time.advance(10_000);
    const report = await w.syncNow();
    expect(report.reason).toBe("syncNow");
    expect(report.outcome).toBe("verified");
    expect((await w.status()).helper.nextDueAt).toBe(report.startedAt - 10_000 + 60_000);
    await w.stop(1_000);
  });

  test("during a cycle, requests share one follow-up that starts after them", async () => {
    const time = fakeTime();
    const engine = fakeEngine(time);
    const gate = deferred();
    engine.gate = gate.promise;
    const { w } = worker(time, engine);
    w.start();
    await time.advance(60_000);
    const requestedAt = time.wall;
    const a = w.syncNow();
    const b = w.syncNow();
    expect(a).toBe(b);
    engine.gate = null;
    gate.resolve();
    const report = await a;
    expect(report.reason).toBe("syncNow");
    expect(report.startedAt).toBeGreaterThanOrEqual(requestedAt);
    expect(engine.calls.filter((c) => c.startsWith("capture")).length).toBe(2);
    expect(engine.maxActive).toBe(1);
    await w.stop(1_000);
  });
});

describe("cycle outcomes come from the engine", () => {
  test("verified only when the cycle's own snapshot is verified", async () => {
    const time = fakeTime();
    const engine = fakeEngine(time);
    engine.verify = () => ({ verified: true, ref: "r", snapshot: "older" });
    const { w } = worker(time, engine);
    w.start();
    expect((await w.syncNow()).outcome).toBe("verify-failed");
    engine.verify = () => ({ verified: false, state: "mismatch", expected: "x", remote: "y" });
    expect((await w.syncNow()).outcome).toBe("verify-failed");
    await w.stop(1_000);
  });

  test("guards and failures are reported, never verified", async () => {
    const time = fakeTime();
    const engine = fakeEngine(time);
    const { w } = worker(time, engine);
    w.start();
    engine.push = () => ({ state: "blocked", reason: "secret-found", message: "a secret", findings: [{ path: "notes/a.md", rule: "generic" } as never] });
    let r = await w.syncNow();
    expect(r.outcome).toBe("blocked");
    expect(r.block?.reason).toBe("secret-found");
    expect(engine.calls.at(-1)).toBe("push");
    engine.push = (s) => ({ state: "rejected", ref: "r", snapshot: s, message: "rejected" });
    expect((await w.syncNow()).outcome).toBe("push-failed");
    engine.api.capture = async () => { throw new BackupRefusedError({ reason: "not-enabled", at: 1, message: "not enabled" }); };
    r = await w.syncNow();
    expect(r.outcome).toBe("blocked");
    expect(r.block?.reason).toBe("not-enabled");
    engine.api.capture = async () => { throw new Error("disk vanished"); };
    r = await w.syncNow();
    expect(r.outcome).toBe("capture-failed");
    expect(r.error).toBe("disk vanished");
    await w.stop(1_000);
  });
});

describe("status", () => {
  test("clean engine answer is 'no known unprotected edits', never 'protected', and keeps the capture horizon uncertainty", async () => {
    const time = fakeTime();
    const engine = fakeEngine(time);
    const { w } = worker(time, engine);
    w.start();
    expect((await w.status()).summary).toBe("unprotected");
    await w.syncNow();
    const s = await w.status();
    expect(s.fresh).toBe(true);
    expect(s.summary).toBe("no-known-unprotected-edits");
    expect(s.uncertainty).toContain("edits-after-last-capture-unknown");
    await w.stop(1_000);
  });

  test("propagates engine age, pending files, blocks and errors", async () => {
    const time = fakeTime();
    const engine = fakeEngine(time);
    const { w } = worker(time, engine);
    w.start();
    await w.syncNow();
    engine.statusValue = async () => status({ protectionAgeSeconds: 42, oldestUnprotectedEdit: 1, pending: ["notes/a.md"] });
    let s = await w.status();
    expect(s.summary).toBe("unprotected");
    expect(s.engine?.protectionAgeSeconds).toBe(42);
    expect(s.uncertainty).toContain("pending-files");
    engine.statusValue = async () => status({ block: { reason: "visibility-unknown", at: 1, message: "unknown" } });
    s = await w.status();
    expect(s.summary).toBe("blocked");
    engine.statusValue = async () => status({ enabled: false });
    expect((await w.status()).summary).toBe("not-enabled");
    engine.statusValue = async () => status({ lastError: { kind: "push-failed", at: 1, message: "x" } });
    expect((await w.status()).summary).toBe("error");
    await w.stop(1_000);
  });

  test("a slow or failing engine status answers 'unknown' with the last known status marked stale", async () => {
    const time = fakeTime();
    const engine = fakeEngine(time);
    const { w } = worker(time, engine);
    w.start();
    await w.syncNow();
    await w.status();
    const slow = deferred<BackupStatus>();
    engine.statusValue = () => slow.promise;
    const pending = w.status();
    await time.advance(1_000);
    const s = await pending;
    expect(s.fresh).toBe(false);
    expect(s.summary).toBe("unknown");
    expect(s.engine).not.toBeNull();
    expect(s.uncertainty).toContain("status-stale");
    expect(s.statusError).toContain("in time");
    slow.resolve(status());
    engine.statusValue = async () => { throw new Error("record unreadable"); };
    const failed = await w.status();
    expect(failed.summary).toBe("unknown");
    expect(failed.statusError).toBe("record unreadable");
    await w.stop(1_000);
  });
});

describe("stop", () => {
  test("waits for a running cycle within the grace period, then cancels it through the engine signal", async () => {
    const time = fakeTime();
    const engine = fakeEngine(time);
    const gate = deferred();
    engine.gate = gate.promise;
    const { w, reports } = worker(time, engine);
    w.start();
    await time.advance(60_000);
    const follow = w.syncNow();
    const stopping = w.stop(2_000);
    await time.advance(2_000);
    expect(engine.signals[0]!.aborted).toBe(true);
    gate.resolve();
    await stopping;
    expect(reports).toEqual(["cancelled"]);
    expect((await follow).outcome).toBe("cancelled");
    expect(engine.calls.filter((c) => c.startsWith("capture")).length).toBe(1);
    expect(time.pending.size).toBe(0);
    await expect(w.syncNow()).rejects.toThrow("not running");
  });

  test("a cycle that finishes within the grace period is kept, not cancelled", async () => {
    const time = fakeTime();
    const engine = fakeEngine(time);
    const gate = deferred();
    engine.gate = gate.promise;
    const { w, reports } = worker(time, engine);
    w.start();
    await time.advance(60_000);
    const stopping = w.stop(10_000);
    await time.advance(1_000);
    gate.resolve();
    await settle();
    await time.advance(10_000);
    await stopping;
    expect(reports).toEqual(["verified"]);
    expect(time.pending.size).toBe(0);
  });
});

describe("missed slots after a long cycle (review finding 2)", () => {
  const offsets = (engine: ReturnType<typeof fakeEngine>, start: number) => engine.calls.filter((c) => c.startsWith("capture")).map((c) => Number(c.split("@")[1]) - start);

  test("a cycle longer than the interval waits for the next future slot; the post-completion timer fires there, not at once", async () => {
    const time = fakeTime();
    const engine = fakeEngine(time);
    const gate = deferred();
    engine.gate = gate.promise;
    const { w } = worker(time, engine);
    const start = time.wall;
    w.start();
    await time.advance(60_000);
    await time.advance(130_000); // the first cycle is still running at +190 s
    engine.gate = null;
    gate.resolve();
    await settle();
    expect((await w.status()).helper.nextDueAt! - start).toBe(240_000);
    await time.advance(49_000);
    expect(offsets(engine, start)).toEqual([60_000]);
    await time.advance(1_000);
    expect(offsets(engine, start)).toEqual([60_000, 240_000]);
    await w.stop(1_000);
  });

  test("a forward wall jump during a cycle skips to the next slot after it", async () => {
    const time = fakeTime();
    const engine = fakeEngine(time);
    const gate = deferred();
    engine.gate = gate.promise;
    const { w } = worker(time, engine);
    const start = time.wall;
    w.start();
    await time.advance(60_000);
    await time.advance(70_000);
    time.sleep(660_000); // wall +790 s, monotonic +130 s
    engine.gate = null;
    gate.resolve();
    await settle();
    await time.advance(49_000);
    expect(offsets(engine, start)).toEqual([60_000]);
    await time.advance(1_000);
    expect(offsets(engine, start)).toEqual([60_000, 840_000]);
    await w.stop(1_000);
  });

  test("after a backward wall jump during a cycle the monotonic fallback still runs the next cycle one interval later", async () => {
    const time = fakeTime();
    const engine = fakeEngine(time);
    const gate = deferred();
    engine.gate = gate.promise;
    const { w } = worker(time, engine);
    w.start();
    await time.advance(60_000);
    time.setWall(time.wall - 3_600_000);
    engine.gate = null;
    gate.resolve();
    await settle();
    await time.advance(59_000);
    expect(engine.calls.filter((c) => c.startsWith("capture")).length).toBe(1);
    await time.advance(1_000);
    expect(engine.calls.filter((c) => c.startsWith("capture")).length).toBe(2);
    await w.stop(1_000);
  });
});

describe("stop with work that ignores cancellation (review finding 3)", () => {
  test("stop waits for the work to end after aborting and reports it as unsettled meanwhile", async () => {
    const time = fakeTime();
    const engine = fakeEngine(time);
    const gate = deferred();
    engine.gate = gate.promise; // the double never looks at its signal
    const { w } = worker(time, engine);
    w.start();
    await time.advance(60_000);
    let stopped = false;
    const stopping = w.stop(1_000).then(() => { stopped = true; });
    await time.advance(5_000);
    expect(engine.signals[0]!.aborted).toBe(true);
    expect(stopped).toBe(false);
    expect(w.unsettled()).toEqual(["cycle"]);
    gate.resolve();
    await stopping;
    expect(w.unsettled()).toEqual([]);
  });

  test("a timer that cannot be armed for the grace period cancels at once and still waits for the work", async () => {
    const time = fakeTime();
    const engine = fakeEngine(time);
    const gate = deferred();
    engine.gate = gate.promise;
    let failTimers = false;
    const timers = { set: (fn: () => void, ms: number) => { if (failTimers) throw new Error("no timer"); return time.timers.set(fn, ms); }, clear: time.timers.clear };
    const { w } = worker(time, engine, { timers });
    w.start();
    await time.advance(60_000);
    failTimers = true;
    let stopped = false;
    const stopping = w.stop(10_000).then(() => { stopped = true; });
    await settle();
    expect(engine.signals[0]!.aborted).toBe(true);
    expect(stopped).toBe(false);
    gate.resolve();
    await stopping;
  });
});
