// r6 (review-writeflex-backup-history-activation-repair-r5, S1-a and S1-b). S1-b: the budget timer and the
// caller's abort listener exist before the host's read is called, so an abort the host causes while it is
// being called settles the caller at once and reaches the inner signal, while the underlying slot stays
// held until the host's work really ends. S1-a: an answer is used only before the deadline (monotonic,
// checked when the work settles and before every successful cohort, empty included); synchronous work is
// not pre-empted, its late answer is refused. Hosts are test hosts (labelled); the engine case is real Git.
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
setDefaultTimeout(30_000);
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBackupEngine } from "./index.ts";
import { checkCohort, projectionAttempt, readProjection, runningProjectionWork, type CaptureProjection, type ProjectionRead } from "./projection.ts";
import { isolatedGitEnv, permissiveGuards, sandbox, type Sandbox } from "./test-fixtures.ts";

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const busy = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end) { /* synchronous host work */ } };
const boxes: Sandbox[] = [];
const releases: Array<() => void> = [];
afterEach(async () => { while (releases.length) releases.pop()!(); await tick(); while (boxes.length) boxes.pop()!.cleanup(); });
const LIMITS = { maxFileBytes: 1000 };
const none = () => false;
/** Slots other test files in this process may still hold (their own names); counts below are relative to it. */
let base = 0;
beforeEach(() => { base = runningProjectionWork(); });

describe("S1-b an abort caused while the host is being called", () => {
  test("settles the caller at once, aborts the inner signal, keeps the slot until the host ends, then frees it", async () => {
    const outer = new AbortController();
    let inner: AbortSignal | undefined;
    let calls = 0;
    const host: CaptureProjection = {
      name: "r6-reentrant", namespaces: [".meta/x/"],
      read: (_root, signal) => {
        calls++;
        inner = signal;
        outer.abort(new Error("cancelled from inside read"));
        return new Promise<ProjectionRead>((r) => releases.push(() => r({ state: "complete", files: [] })));
      },
    };
    const began = performance.now();
    let outcome: unknown = "pending";
    const caller = projectionAttempt(host, "/r6-a", [".meta/x/"], LIMITS, none, { signal: outer.signal, budgetMs: 60_000 }).then((x) => { outcome = x; }, (e) => { outcome = e; });
    await caller;
    // Settled by the abort, not by the 60 s budget; the inner signal saw it.
    expect(performance.now() - began).toBeLessThan(1000);
    expect(String((outcome as Error).message)).toBe("cancelled from inside read");
    expect(inner?.aborted).toBe(true);
    // The host's work is still running: its slot is held, and new attempts are refused without calling it
    // and without creating a timer or a listener of their own.
    expect(runningProjectionWork()).toBe(base + 1);
    const realSet = globalThis.setTimeout;
    let timers = 0;
    const ac = new AbortController();
    let listeners = 0;
    const add = ac.signal.addEventListener.bind(ac.signal);
    ac.signal.addEventListener = ((...a: Parameters<typeof add>) => { listeners++; return add(...a); }) as typeof add;
    globalThis.setTimeout = ((...a: Parameters<typeof realSet>) => { timers++; return realSet(...a); }) as typeof realSet;
    try {
      for (let i = 0; i < 20; i++) {
        const again = await projectionAttempt(host, "/r6-a", [".meta/x/"], LIMITS, none, { signal: ac.signal, budgetMs: 60_000 });
        expect("unavailable" in again && again.unavailable).toBe("an earlier read of it for this folder has not ended yet");
      }
    } finally {
      globalThis.setTimeout = realSet;
    }
    expect({ calls, timers, listeners }).toEqual({ calls: 1, timers: 0, listeners: 0 });
    // The host ends: the slot is free and a new attempt reads again.
    releases.pop()!();
    await tick();
    expect(runningProjectionWork()).toBe(base);
    const fresh = await projectionAttempt({ ...host, read: async () => ({ state: "complete", files: [] }) }, "/r6-a", [".meta/x/"], LIMITS, none, { budgetMs: 1000 });
    expect(fresh).toEqual({ files: [], answer: { state: "complete", files: [] } });
  });

  test("readProjection too: the host-caused abort rejects at once and the inner signal is aborted", async () => {
    const outer = new AbortController();
    let inner: AbortSignal | undefined;
    const host: CaptureProjection = {
      name: "r6-reentrant-read", namespaces: [".meta/x/"],
      read: (_root, signal) => { inner = signal; outer.abort(new Error("stop")); return new Promise<ProjectionRead>((r) => releases.push(() => r({ state: "complete", files: [] }))); },
    };
    const began = performance.now();
    await expect(readProjection(host, "/r6-b", { signal: outer.signal, budgetMs: 60_000 })).rejects.toThrow("stop");
    expect(performance.now() - began).toBeLessThan(1000);
    expect(inner?.aborted).toBe(true);
    expect(runningProjectionWork()).toBe(base + 1);
  });

  test("an already aborted caller still never calls the host (control)", async () => {
    const outer = new AbortController();
    outer.abort(new Error("before"));
    let calls = 0;
    const host: CaptureProjection = { name: "r6-pre-aborted", namespaces: [".meta/x/"], read: async () => { calls++; return { state: "complete", files: [] }; } };
    expect(() => projectionAttempt(host, "/r6-c", [".meta/x/"], LIMITS, none, { signal: outer.signal, budgetMs: 1000 })).toThrow("before");
    expect(calls).toBe(0);
    expect(runningProjectionWork()).toBe(base);
  });
});

describe("S1-a an answer after the deadline is never used", () => {
  test("synchronous host past its budget with an empty complete cohort: unavailable; within budget: the empty cohort is a real answer", async () => {
    const late: CaptureProjection = { name: "r6-empty-late", namespaces: [".meta/x/"], read: async () => { busy(25); return { state: "complete", files: [] }; } };
    const lateResult = await projectionAttempt(late, "/r6-d", [".meta/x/"], LIMITS, none, { budgetMs: 5 });
    expect("unavailable" in lateResult).toBe(true);
    const lateRead = await readProjection(late, "/r6-d", { budgetMs: 5 });
    expect(lateRead.state).toBe("unavailable");
    // Control: the same empty cohort in time is accepted.
    const quick: CaptureProjection = { ...late, read: async () => ({ state: "complete", files: [] }) };
    expect(await projectionAttempt(quick, "/r6-d", [".meta/x/"], LIMITS, none, { budgetMs: 1000 })).toEqual({ files: [], answer: { state: "complete", files: [] } });
    expect(runningProjectionWork()).toBe(base);
  });

  test("a host that returns synchronously (no await at all) past its budget: unavailable", async () => {
    const sync: CaptureProjection = { name: "r6-sync", namespaces: [".meta/x/"], read: (() => { busy(25); return Promise.resolve({ state: "complete", files: [] }); }) as CaptureProjection["read"] };
    expect("unavailable" in (await projectionAttempt(sync, "/r6-e", [".meta/x/"], LIMITS, none, { budgetMs: 5 }))).toBe(true);
  });

  test("checkCohort: an empty or a non-empty cohort with the deadline passed is unavailable", async () => {
    const past = performance.now() - 1;
    expect(await checkCohort("/r6-f", [".meta/x/"], { state: "complete", files: [] }, LIMITS, none, { deadline: past })).toEqual({ unavailable: "the projection could not be checked within its time budget" });
    expect("unavailable" in (await checkCohort("/r6-f", [".meta/x/"], { state: "complete", files: [{ path: ".meta/x/a", content: Buffer.from("a") }] }, LIMITS, none, { deadline: past }))).toBe(true);
    // Control: no deadline, empty cohort accepted.
    expect(await checkCohort("/r6-f", [".meta/x/"], { state: "complete", files: [] }, LIMITS, none)).toEqual({ files: [] });
  });

  test("engine: an empty-history capture whose host ran past the budget is held back; the snapshot does not move; a timely one commits", async () => {
    const b = sandbox();
    boxes.push(b);
    let slow = false;
    const host: CaptureProjection = { name: "r6-engine-empty", namespaces: [".meta/history/"], read: async () => { if (slow) busy(25); return { state: "complete", files: [] }; } };
    const engine = createBackupEngine({ machineId: "r6", settleMs: 1, gitEnv: isolatedGitEnv, ...permissiveGuards, historyProjection: host, projectionBudgetMs: 5 });
    const scope = { include: ["**/*.md"], exclude: [".meta"] };
    writeFileSync(join(b.repo, "a.md"), "one");
    await engine.enable(b.repo);
    const first = await engine.capture(b.repo, scope);
    slow = true;
    writeFileSync(join(b.repo, "a.md"), "two");
    const refused = await engine.capture(b.repo, scope).then(() => null, (e: { reason?: string }) => e);
    expect(refused?.reason).toBe("history-unavailable");
    const held = await engine.status(b.repo);
    expect(held.latestSnapshot).toBe(first.snapshot);
    expect(held.block?.reason).toBe("history-unavailable");
    slow = false;
    const next = await engine.capture(b.repo, scope);
    expect(next.snapshot).not.toBe(first.snapshot);
    expect((await engine.status(b.repo)).block).toBeNull();
  });
});
