// r4 (review-writeflex-backup-history-activation-r3, E1, S1, S2): the projection's wait is covered by the
// capture's final write-generation and safety checks; the engine owns the projection's budget and abort,
// whatever the host does; and a capture held back by its projection stays shown until a complete cohort
// is captured, whatever an older snapshot's push or verification says. Real Git, a local bare remote, real
// engine and helper preview; projections are test hosts (labelled). No network, no credential.
import { setDefaultTimeout, afterEach, describe, expect, test } from "bun:test";
setDefaultTimeout(30_000);
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBackupEngine, type BackupEngine, type CaptureProjection, type ProjectionRead } from "./index.ts";
import { git, isolatedGitEnv, permissiveGuards, sandbox, type Sandbox } from "./test-fixtures.ts";
import * as projection from "./projection.ts";
import { checkCohort } from "./projection.ts";
import { parseHelperConfig } from "./helper/config.ts";
import { previewVault } from "./helper/enrol.ts";

const boxes: Sandbox[] = [];
afterEach(() => { while (boxes.length) boxes.pop()!.cleanup(); });
const SCOPE = { include: ["**/*.md"], exclude: [".meta"] };
const HISTORY = { path: ".meta/history", content: Buffer.from("x") };
function box(): Sandbox {
  const b = sandbox();
  boxes.push(b);
  writeFileSync(join(b.repo, "a.md"), "BASELINE\n");
  mkdirSync(join(b.repo, ".meta"));
  writeFileSync(join(b.repo, ".meta", "history"), "x");
  return b;
}
const engine = (p: CaptureProjection, extra: Record<string, unknown> = {}) => createBackupEngine({ machineId: "test-mac", settleMs: 1, gitEnv: isolatedGitEnv, ...permissiveGuards, historyProjection: p, ...extra });
/** TEST HOST: answers `answer()`; `during()` runs inside the read of the chosen call. */
function host(answer: () => ProjectionRead | Promise<ProjectionRead>, during?: { call: number; run: () => Promise<void> }) {
  let calls = 0;
  const p: CaptureProjection = { name: "test-history", namespaces: [".meta/history"], async read() { calls++; if (during && calls === during.call) await during.run(); return answer(); } };
  return { p, calls: () => calls };
}
const complete = (): ProjectionRead => ({ state: "complete", files: [HISTORY] });
const show = (b: Sandbox, snapshot: string, path: string) => git(b.repo, ["show", `${snapshot}:${path}`]).toString();
const record = (b: Sandbox) => JSON.parse(readFileSync(join(b.repo, ".git", "vault-sync", "deadline.json"), "utf8"));
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => (resolve = r)); return { promise, resolve }; };

describe("E1 the final ordinary checks follow the projection's wait", () => {
  test("a write that starts and finishes during the projection: the intermediate bytes are never committed as complete", async () => {
    const b = box();
    let e!: BackupEngine;
    const h = host(complete, { call: 2, run: async () => {
      const token = await e.noteWriteStart(b.repo, ["a.md"]);
      writeFileSync(join(b.repo, "a.md"), "LATEST DURABLE\n");
      await e.noteFlush(b.repo, { upTo: 0, paths: ["a.md"], completedWrites: [{ path: "a.md", token }] });
    } });
    e = engine(h.p);
    await e.enable(b.repo);
    await e.capture(b.repo, SCOPE);
    writeFileSync(join(b.repo, "a.md"), "INTERMEDIATE\n");
    const result = await e.capture(b.repo, SCOPE);
    // The pass that read INTERMEDIATE is discarded for a.md; a retry reads the latest bytes.
    expect(show(b, result.snapshot!, "a.md")).toBe("LATEST DURABLE\n");
    expect(h.calls()).toBeGreaterThanOrEqual(3);
  });

  test("a write that starts during the projection and is still open: the path stays pending, its old bytes kept", async () => {
    const b = box();
    let e!: BackupEngine;
    const h = host(complete, { call: 2, run: async () => { await e.noteWriteStart(b.repo, ["a.md"]); writeFileSync(join(b.repo, "a.md"), "HALF WRITTEN\n"); } });
    e = engine(h.p);
    await e.enable(b.repo);
    const first = await e.capture(b.repo, SCOPE);
    writeFileSync(join(b.repo, "a.md"), "INTERMEDIATE\n");
    const result = await e.capture(b.repo, SCOPE);
    expect(result.pending).toContainEqual({ path: "a.md", reason: "writing" });
    expect(show(b, result.snapshot!, "a.md")).toBe(show(b, first.snapshot!, "a.md"));
    expect(record(b).writes["a.md"]).toMatchObject({ active: true });
  });

  test("a deletion seen before the projection and a write during it: the removal is not committed", async () => {
    const b = box();
    let e!: BackupEngine;
    const h = host(complete, { call: 2, run: async () => {
      const token = await e.noteWriteStart(b.repo, ["a.md"]);
      writeFileSync(join(b.repo, "a.md"), "RECREATED\n");
      await e.noteFlush(b.repo, { upTo: 0, paths: ["a.md"], completedWrites: [{ path: "a.md", token }] });
    } });
    e = engine(h.p);
    await e.enable(b.repo);
    await e.capture(b.repo, SCOPE);
    rmSync(join(b.repo, "a.md"));
    const result = await e.capture(b.repo, SCOPE);
    expect(result.removed).not.toContain("a.md");
    expect(show(b, result.snapshot!, "a.md")).toBe("RECREATED\n");
  });

  test("the record's safety changes during the projection (a newer engine's ledger appears): the whole attempt is discarded", async () => {
    const b = box();
    const file = join(b.repo, ".git", "vault-sync", "deadline.json");
    const h = host(complete, { call: 2, run: async () => { writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), receipts: { v: 99 } })); } });
    const e = engine(h.p);
    await e.enable(b.repo);
    const first = await e.capture(b.repo, SCOPE);
    writeFileSync(join(b.repo, "a.md"), "CHANGED\n");
    await expect(e.capture(b.repo, SCOPE)).rejects.toThrow("newer engine");
    expect((await e.status(b.repo)).latestSnapshot).toBe(first.snapshot);
  });
});

describe("S1 the engine owns the projection's budget and abort", () => {
  test("a host that ignores the signal: abort settles the capture at once; its late answer changes nothing; the next capture runs", async () => {
    const b = box();
    const entered = deferred();
    const release = deferred();
    let hang = true;
    const h = host(async () => { if (hang) { entered.resolve(); await release.promise; return { state: "complete", files: [{ path: ".meta/history", content: Buffer.from("LATE") }] }; } return complete(); });
    const e = engine(h.p);
    await e.enable(b.repo);
    hang = false;
    const first = await e.capture(b.repo, SCOPE);
    hang = true;
    writeFileSync(join(b.repo, "a.md"), "CHANGED\n");
    const ac = new AbortController();
    let settled = false;
    const running = e.capture(b.repo, SCOPE, { signal: ac.signal }).catch((x) => x).finally(() => { settled = true; });
    await entered.promise;
    ac.abort();
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(true);
    expect(await running).toBeInstanceOf(Error);
    // The late answer arrives: no snapshot, no credit.
    hang = false;
    release.resolve();
    await new Promise((r) => setTimeout(r, 20));
    expect((await e.status(b.repo)).latestSnapshot).toBe(first.snapshot);
    // The operation lock was released: the next capture proceeds and commits the change.
    const next = await e.capture(b.repo, SCOPE);
    expect(show(b, next.snapshot!, "a.md")).toBe("CHANGED\n");
    expect(show(b, next.snapshot!, ".meta/history")).toBe("x");
  });

  test("a host that never answers: the attempt ends at its budget as history-unavailable; nothing partial is published", async () => {
    const b = box();
    let never = false;
    const h = host(() => (never ? new Promise<ProjectionRead>(() => undefined) : complete()));
    const e = engine(h.p, { projectionBudgetMs: 60 });
    await e.enable(b.repo);
    const first = await e.capture(b.repo, SCOPE);
    never = true;
    writeFileSync(join(b.repo, "a.md"), "CHANGED\n");
    const began = performance.now();
    const error = await e.capture(b.repo, SCOPE).catch((x) => x);
    expect(error.reason).toBe("history-unavailable");
    expect(error.message).toContain("did not answer");
    expect(performance.now() - began).toBeLessThan(5_000);
    expect((await e.status(b.repo)).latestSnapshot).toBe(first.snapshot);
  });

  test("an already aborted caller never calls the host", async () => {
    const h = host(complete);
    const ac = new AbortController();
    ac.abort(new Error("stopped first"));
    expect(() => projection.readProjection(h.p, "/nowhere", { signal: ac.signal, budgetMs: 1000 })).toThrow("stopped first");
    expect(h.calls()).toBe(0);
    expect(await projection.readProjection(h.p, "/nowhere", { budgetMs: 0 })).toMatchObject({ state: "unavailable" });
    expect(h.calls()).toBe(0);
  });

  test("the cohort check bounds all projected bytes together and stops at its deadline", async () => {
    const b = box();
    const files = [{ path: ".meta/history", content: Buffer.alloc(60) }, { path: ".meta/other", content: Buffer.alloc(60) }];
    writeFileSync(join(b.repo, ".meta", "other"), "");
    expect(await checkCohort(b.repo, [".meta/"], { state: "complete", files }, { maxFileBytes: 100, maxTotalBytes: 100 }, () => false)).toMatchObject({ unavailable: expect.stringContaining("in total") });
    expect(await checkCohort(b.repo, [".meta/"], { state: "complete", files }, { maxFileBytes: 100, maxTotalBytes: 200 }, () => false, { deadline: performance.now() - 1 })).toMatchObject({ unavailable: expect.stringContaining("time budget") });
    expect("files" in (await checkCohort(b.repo, [".meta/"], { state: "complete", files }, { maxFileBytes: 100, maxTotalBytes: 200 }, () => false))).toBe(true);
  });

  test("a preview with a host that never answers ends within its budget as unavailable", async () => {
    const b = box();
    const GIT = ["/Library/Developer/CommandLineTools/usr/bin/git", "/Applications/Xcode.app/Contents/Developer/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"].find((p) => existsSync(p)) ?? "/usr/bin/git";
    const GITLEAKS = ["/opt/homebrew/bin/gitleaks", "/usr/local/bin/gitleaks"].find((p) => existsSync(p));
    if (!GITLEAKS) throw new Error("this test needs a real gitleaks 8 at /opt/homebrew/bin or /usr/local/bin");
    const cfg = await parseHelperConfig({ configVersion: 2, machineId: "test-mac", tools: { git: GIT, gitleaks: GITLEAKS }, vaults: [{ id: "v", path: b.repo, include: ["**/*.md"], exclude: [".meta"], remote: "origin", history: "test-history" }] });
    const hung: CaptureProjection = { name: "test-history", namespaces: [".meta/history"], read: () => new Promise<ProjectionRead>(() => undefined) };
    const began = performance.now();
    const p = await previewVault(cfg, "v", { mountInfo: async () => null, homeDir: "/nonexistent-test-home", projections: { "test-history": () => hung }, projectionBudgetMs: 60 });
    expect(p.history).toMatchObject({ state: "unavailable", reason: expect.stringContaining("did not answer") });
    expect(performance.now() - began).toBeLessThan(10_000);
  });
});

describe("S2 a capture held back by its projection stays shown until a complete cohort is captured", () => {
  test("good capture, push, verify; projection fails; the older snapshot's push and verify keep the block; a complete (unchanged) capture clears it", async () => {
    const b = box();
    let unavailable = false;
    const e = engine(host(() => (unavailable ? { state: "unavailable", reason: "broken history" } : complete())).p);
    await e.enable(b.repo);
    await e.capture(b.repo, SCOPE);
    expect((await e.pushBackup(b.repo)).state).toBe("pushed");
    expect((await e.verify(b.repo)).verified).toBe(true);
    unavailable = true;
    expect((await e.capture(b.repo, SCOPE).catch((x) => x)).reason).toBe("history-unavailable");
    expect((await e.status(b.repo)).block?.reason).toBe("history-unavailable");
    // Transport of the older snapshot is reported as it is, without clearing the capture's condition.
    expect((await e.pushBackup(b.repo)).state).toBe("up-to-date");
    expect((await e.verify(b.repo)).verified).toBe(true);
    expect((await e.status(b.repo)).block?.reason).toBe("history-unavailable");
    // Enabling again does not clear it either.
    await e.enable(b.repo);
    expect((await e.status(b.repo)).block?.reason).toBe("history-unavailable");
    // A complete cohort, even an unchanged one, ends it.
    unavailable = false;
    const again = await e.capture(b.repo, SCOPE);
    expect(again.committed).toBe(false);
    expect((await e.status(b.repo)).block).toBeNull();
  });
});
