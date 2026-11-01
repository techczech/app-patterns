// r5 (review-writeflex-backup-history-activation-repair-r4, S1, S2). S1: admission is of the host's and the
// cohort check's actual work, not of the caller's wait; one budget covers the whole attempt, final
// containment check included. S2: the stored captureBlock is checked before status uses it. Real Git, real
// engine and status view; projections are test hosts (labelled). The containment check is wrapped by a
// process-local module mock that delays or holds it only while a test switches it on (otherwise it is the
// original function). No network, no credential.
import { afterAll, afterEach, describe, expect, mock, setDefaultTimeout, test } from "bun:test";
setDefaultTimeout(30_000);
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as stableRead from "./stable-read.ts";

const original = { ...stableRead };
/** TEST SWITCH for the wrapped containment check: null = the original, unchanged. */
let containment: null | { delayMs: number } | { hold: Promise<void> } = null;
let containmentCalls = 0;
mock.module("./stable-read.ts", () => ({
  ...original,
  checkContainment: async (root: string, path: string) => {
    // Only the projected paths (under .meta/); ordinary reads are never delayed.
    const c = path.includes("/.meta/") ? containment : null;
    if (c) containmentCalls++;
    const r = await original.checkContainment(root, path);
    if (c && "delayMs" in c) await new Promise((x) => setTimeout(x, c.delayMs));
    if (c && "hold" in c) await c.hold;
    return r;
  },
}));
afterAll(() => { containment = null; mock.module("./stable-read.ts", () => original); });

const { createBackupEngine } = await import("./index.ts");
const { projectionAttempt, readProjection, runningProjectionWork } = await import("./projection.ts");
const { engineStatusView } = await import("./helper/status-view.ts");
const { isolatedGitEnv, permissiveGuards, sandbox } = await import("./test-fixtures.ts");
import type { CaptureProjection, ProjectionRead } from "./index.ts";
import type { Sandbox } from "./test-fixtures.ts";

const boxes: Sandbox[] = [];
afterEach(() => { containment = null; containmentCalls = 0; while (boxes.length) boxes.pop()!.cleanup(); });
const SCOPE = { include: ["**/*.md"], exclude: [".meta"] };
function box(): Sandbox {
  const b = sandbox();
  boxes.push(b);
  writeFileSync(join(b.repo, "a.md"), "BASELINE\n");
  mkdirSync(join(b.repo, ".meta"));
  writeFileSync(join(b.repo, ".meta", "history"), "x");
  return b;
}
const complete = (): ProjectionRead => ({ state: "complete", files: [{ path: ".meta/history", content: Buffer.from("x") }] });
const engine = (p: CaptureProjection, extra: Record<string, unknown> = {}) => createBackupEngine({ machineId: "test-mac", settleMs: 1, gitEnv: isolatedGitEnv, ...permissiveGuards, historyProjection: p, ...extra });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => (resolve = r)); return { promise, resolve }; };
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("S1 outstanding work is bounded across timeouts and aborts", () => {
  test("eight sequential 20 ms timeouts with a host that ignores its signal: at most one host read runs; after it ends a capture succeeds", async () => {
    const b = box();
    let hang = false;
    let active = 0;
    let peak = 0;
    let calls = 0;
    const release: Array<() => void> = [];
    // TEST HOST: does not cooperate with its signal; stops only when released.
    const p: CaptureProjection = { name: "r5-host", namespaces: [".meta/history"], read: async () => {
      calls++;
      if (!hang) return complete();
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((r) => release.push(r));
      active--;
      return complete();
    } };
    const e = engine(p, { projectionBudgetMs: 20 });
    try {
      await e.enable(b.repo);
      const first = await e.capture(b.repo, SCOPE);
      hang = true;
      const counts: number[] = [];
      for (let i = 0; i < 8; i++) {
        const error = await e.capture(b.repo, SCOPE).catch((x) => x);
        expect(error.reason).toBe("history-unavailable");
        counts.push(active);
      }
      expect(counts).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
      expect(peak).toBe(1);
      expect(calls).toBe(2);
      expect(runningProjectionWork()).toBe(1);
      // The later attempts said why at once, without calling the host.
      expect((await e.capture(b.repo, SCOPE).catch((x) => x)).message).toContain("has not ended yet");
      expect((await e.status(b.repo)).latestSnapshot).toBe(first.snapshot);
      // The old read ends: its late answer credits nothing, the slot frees, and a fresh capture succeeds.
      hang = false;
      for (const r of release.splice(0)) r();
      await tick();
      expect(runningProjectionWork()).toBe(0);
      writeFileSync(join(b.repo, "a.md"), "CHANGED\n");
      const next = await e.capture(b.repo, SCOPE);
      expect(next.snapshot).not.toBe(first.snapshot);
      expect((await e.status(b.repo)).block).toBeNull();
    } finally {
      for (const r of release) r();
    }
  });

  test("an abort while the host runs: the caller gets its abort at once, the slot is held until the host ends, its late answer is ignored", async () => {
    const b = box();
    const gate = deferred();
    let calls = 0;
    const p: CaptureProjection = { name: "r5-abort", namespaces: [".meta/history"], read: async () => { calls++; await gate.promise; return complete(); } };
    const ac = new AbortController();
    const attempt = projectionAttempt(p, b.repo, [".meta/history"], { maxFileBytes: 100 }, () => false, { signal: ac.signal, budgetMs: 10_000 });
    await tick();
    ac.abort(new Error("caller stopped"));
    await expect(attempt).rejects.toThrow("caller stopped");
    expect(runningProjectionWork()).toBe(1);
    expect(await projectionAttempt(p, b.repo, [".meta/history"], { maxFileBytes: 100 }, () => false, { budgetMs: 10_000 })).toMatchObject({ unavailable: expect.stringContaining("has not ended yet") });
    expect(calls).toBe(1);
    gate.resolve();
    await tick();
    expect(runningProjectionWork()).toBe(0);
    // Already aborted: the host is never called.
    expect(() => readProjection(p, b.repo, { signal: ac.signal, budgetMs: 10_000 })).toThrow("caller stopped");
    expect(calls).toBe(1);
  });
});

describe("S1 through the engine", () => {
  test("a capture aborted while its host runs: the next capture is refused at once without a second host read, until the first ends", async () => {
    const b = box();
    let gate: ReturnType<typeof deferred> | null = null;
    let calls = 0;
    const p: CaptureProjection = { name: "r5-engine-abort", namespaces: [".meta/history"], read: async () => { calls++; if (gate) await gate.promise; return complete(); } };
    const e = engine(p);
    await e.enable(b.repo);
    const first = await e.capture(b.repo, SCOPE);
    gate = deferred();
    const ac = new AbortController();
    const aborted = e.capture(b.repo, SCOPE, { signal: ac.signal }).catch((x) => x);
    for (let i = 0; i < 400 && calls < 2; i++) await tick();
    expect(calls).toBe(2);
    ac.abort(new Error("caller stopped"));
    expect(String(await aborted)).toContain("caller stopped");
    const refused = await e.capture(b.repo, SCOPE).catch((x) => x);
    expect(refused.reason).toBe("history-unavailable");
    expect(calls).toBe(2);
    gate.resolve();
    gate = null;
    await tick();
    writeFileSync(join(b.repo, "a.md"), "CHANGED\n");
    expect((await e.capture(b.repo, SCOPE)).snapshot).not.toBe(first.snapshot);
  });

  test("a containment check that never settles: captures end at their budget and start no new check until it ends", async () => {
    const b = box();
    const p: CaptureProjection = { name: "r5-engine-held", namespaces: [".meta/history"], read: async () => complete() };
    const e = engine(p, { projectionBudgetMs: 15 });
    await e.enable(b.repo);
    const first = await e.capture(b.repo, SCOPE);
    const gate = deferred();
    containment = { hold: gate.promise };
    try {
      for (let i = 0; i < 6; i++) expect((await e.capture(b.repo, SCOPE).catch((x) => x)).reason).toBe("history-unavailable");
      expect(containmentCalls).toBe(1);
    } finally {
      containment = null;
      gate.resolve();
    }
    await tick();
    writeFileSync(join(b.repo, "a.md"), "CHANGED\n");
    expect((await e.capture(b.repo, SCOPE)).snapshot).not.toBe(first.snapshot);
  }, 5_000);
});

describe("S1 one deadline covers the host and the whole cohort check", () => {
  test("10 ms budget, final containment answering after 40 ms: unavailable within the budget's bound, never accepted late", async () => {
    const b = box();
    containment = { delayMs: 40 };
    const p: CaptureProjection = { name: "r5-slow-check", namespaces: [".meta/history"], read: async () => complete() };
    const began = performance.now();
    const result = await projectionAttempt(p, b.repo, [".meta/history"], { maxFileBytes: 100 }, () => false, { budgetMs: 10 });
    const elapsed = performance.now() - began;
    expect(result).toMatchObject({ unavailable: expect.stringContaining("did not answer") });
    expect("files" in result).toBe(false);
    expect(elapsed).toBeLessThan(35);
    await new Promise((r) => setTimeout(r, 60));
    expect(runningProjectionWork()).toBe(0);
  });

  test("a containment check that never settles: the attempt ends at its budget, and later attempts start no new check until it ends", async () => {
    const b = box();
    const gate = deferred();
    containment = { hold: gate.promise };
    const p: CaptureProjection = { name: "r5-held-check", namespaces: [".meta/history"], read: async () => complete() };
    const first = await projectionAttempt(p, b.repo, [".meta/history"], { maxFileBytes: 100 }, () => false, { budgetMs: 15 });
    expect(first).toMatchObject({ unavailable: expect.stringContaining("did not answer") });
    for (let i = 0; i < 5; i++) expect(await projectionAttempt(p, b.repo, [".meta/history"], { maxFileBytes: 100 }, () => false, { budgetMs: 15 })).toMatchObject({ unavailable: expect.stringContaining("has not ended yet") });
    expect(containmentCalls).toBe(1);
    expect(runningProjectionWork()).toBe(1);
    containment = null;
    gate.resolve();
    await tick();
    expect(runningProjectionWork()).toBe(0);
    expect(await projectionAttempt(p, b.repo, [".meta/history"], { maxFileBytes: 100 }, () => false, { budgetMs: 1_000 })).toMatchObject({ files: [{ path: ".meta/history" }] });
  });

  test("a capture's projection budget covers the cohort check too (no late acceptance through capture)", async () => {
    const b = box();
    const p: CaptureProjection = { name: "r5-capture-check", namespaces: [".meta/history"], read: async () => complete() };
    const e = engine(p, { projectionBudgetMs: 10 });
    await e.enable(b.repo);
    containment = { delayMs: 40 };
    const error = await e.capture(b.repo, SCOPE).catch((x) => x);
    expect(error.reason).toBe("history-unavailable");
    expect((await e.status(b.repo)).latestSnapshot).toBeNull();
  });
});

describe("S2 the stored captureBlock is checked before status uses it", () => {
  const deadlineFile = (b: Sandbox) => join(b.repo, ".git", "vault-sync", "deadline.json");
  async function captured() {
    const b = box();
    let unavailable = false;
    const e = engine({ name: "r5-status", namespaces: [".meta/history"], read: async () => (unavailable ? { state: "unavailable", reason: "broken history" } : complete()) });
    await e.enable(b.repo);
    await e.capture(b.repo, SCOPE);
    expect((await e.pushBackup(b.repo)).state).toBe("pushed");
    expect((await e.verify(b.repo)).verified).toBe(true);
    return { b, e, setUnavailable: (v: boolean) => { unavailable = v; } };
  }

  test("absent or null stays healthy; a valid block is kept exactly", async () => {
    const { b, e } = await captured();
    const record = JSON.parse(readFileSync(deadlineFile(b), "utf8"));
    for (const value of [undefined, null]) {
      writeFileSync(deadlineFile(b), JSON.stringify({ ...record, captureBlock: value }));
      expect((await e.status(b.repo)).block).toBeNull();
    }
    const valid = { reason: "history-unavailable" as const, at: 5, message: "test-history: broken; this capture is held back" };
    writeFileSync(deadlineFile(b), JSON.stringify({ ...record, captureBlock: valid }));
    const status = await e.status(b.repo);
    expect(status.block).toEqual(valid);
    expect(engineStatusView(status, 10)?.block).toEqual(valid);
  });

  test("every malformed or unsupported shape becomes the canonical history-unavailable block; the view never throws; other fields stay", async () => {
    const { b, e } = await captured();
    const record = JSON.parse(readFileSync(deadlineFile(b), "utf8"));
    const shapes: unknown[] = [
      { reason: "history-unavailable", at: 1 },
      { reason: "history-unavailable", at: 1, message: 7 },
      { reason: "history-unavailable", at: "yesterday", message: "m" },
      { reason: "history-unavailable", at: -1, message: "m" },
      { reason: "history-unavailable", at: 1, message: "" },
      { reason: "history-unavailable", at: 1, message: "m".repeat(5000) },
      { reason: "a-future-reason", at: 2, message: "m", extra: [1] },
      { reason: "secret-found", at: 2, message: "m", findings: "not a list" },
      [], ["history-unavailable"], "history-unavailable", 42, true,
    ];
    for (const shape of shapes) {
      writeFileSync(deadlineFile(b), JSON.stringify({ ...record, captureBlock: shape }));
      const status = await e.status(b.repo);
      // Plain checks: Bun 1.3.10's toMatchObject writes asymmetric matchers into the object it checks.
      expect(status.block?.reason).toBe("history-unavailable");
      expect(status.block?.message).toContain("could not be read");
      expect(Number.isFinite(status.block!.at)).toBe(true);
      expect(status.recoveredFromDamagedRecord).toBe(false);
      expect(status.lastVerifiedSnapshot).toBe(record.lastVerifiedSnapshot);
      expect(() => engineStatusView(status, 10)).not.toThrow();
      expect(engineStatusView(status, 10)!.block!.message.length).toBeLessThanOrEqual(501);
    }
  });

  test("a malformed block survives push, verify and enable as unavailable, and a complete capture clears it after a reload", async () => {
    const { b, e } = await captured();
    const record = JSON.parse(readFileSync(deadlineFile(b), "utf8"));
    writeFileSync(deadlineFile(b), JSON.stringify({ ...record, captureBlock: { reason: "history-unavailable", at: 1 } }));
    await e.pushBackup(b.repo);
    await e.verify(b.repo);
    await e.enable(b.repo);
    expect((await e.status(b.repo)).block?.reason).toBe("history-unavailable");
    // A fresh engine over the same record (a restart) sees the same conservative block.
    const again = engine({ name: "r5-status", namespaces: [".meta/history"], read: async () => complete() });
    expect((await again.status(b.repo)).block?.reason).toBe("history-unavailable");
    await again.capture(b.repo, SCOPE);
    expect((await again.status(b.repo)).block).toBeNull();
    expect(JSON.parse(readFileSync(deadlineFile(b), "utf8")).captureBlock).toBeNull();
  });

  test("a current history-unavailable capture still persists through an older snapshot's push, verify and enable", async () => {
    const { b, e, setUnavailable } = await captured();
    setUnavailable(true);
    expect((await e.capture(b.repo, SCOPE).catch((x) => x)).reason).toBe("history-unavailable");
    await e.pushBackup(b.repo);
    await e.verify(b.repo);
    await e.enable(b.repo);
    const status = await e.status(b.repo);
    expect(status.block?.reason).toBe("history-unavailable");
    expect(status.block?.message).toContain("broken history");
    expect(engineStatusView(status, 10)!.block!.message).toContain("broken history");
  });
});
