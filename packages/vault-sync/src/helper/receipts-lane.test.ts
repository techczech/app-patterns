/**
 * Receipts lane over real local sockets: the connection server with fake vault workers and a real
 * disposable engine on a disposable repository (or a fake receipt API where noted). Process observations
 * are injected; nothing here starts, inspects or signals a real process other than Git for the fixtures.
 */
import { setDefaultTimeout, afterEach, describe, expect, test } from "bun:test";
setDefaultTimeout(30_000);
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createBackupEngine, type BackupEngine } from "../engine.ts";
import { receiptTestHooks, type ReceiptsApi } from "../engine-receipts.ts";
import { engineFolder } from "../engine-store.ts";
import type { HelperIncarnation, WriterIncarnation } from "../receipt-ledger.ts";
import { compileScope } from "../scope.ts";
import { git, gitText, isolatedGitEnv, permissiveGuards, sandbox } from "../test-fixtures.ts";
import type { PriorShutdownEvidence } from "./activation.ts";
import { connectHelper } from "./client.ts";
import { serveConnection } from "./connection.ts";
import type { ProcessObservation, ProcessObserver } from "./process-observer.ts";
import { connectReceipts, ReceiptsClientError, type ReceiptsClient } from "./receipt-client.ts";
import { createWorkTracker, type ReceiptLaneContext, type ReceiptVault } from "./receipt-session.ts";
import { HELPER_VERSION } from "./server.ts";
import { systemTimers, type CycleReport, type VaultWorker } from "./vault-worker.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const key of Object.keys(receiptTestHooks)) delete (receiptTestHooks as Record<string, unknown>)[key];
  while (cleanups.length) await cleanups.pop()!();
});

const HOST = "test-host";
const H1: HelperIncarnation = { host: HOST, pid: 4001, startedAt: 1_700_000_001_000, helperVersion: HELPER_VERSION };
const H2: HelperIncarnation = { host: HOST, pid: 4002, startedAt: 1_700_000_002_000, helperVersion: HELPER_VERSION };
const H3: HelperIncarnation = { host: HOST, pid: 4003, startedAt: 1_700_000_003_000, helperVersion: HELPER_VERSION };
const W4: WriterIncarnation = { host: HOST, pid: 5004, startedAt: 1_700_000_004_000, clientEpoch: 4 };
const W5: WriterIncarnation = { host: HOST, pid: 5005, startedAt: 1_700_000_005_000, clientEpoch: 5 };
const CLIENT = "c".repeat(32);
const OTHER = "d".repeat(32);
const OWNER4 = "a".repeat(32);
const OWNER5 = "b".repeat(32);
const doc4 = { owner: OWNER4, ownerEpoch: 4, docEpoch: 1 };
const intent = (n: number) => n.toString(16).padStart(32, "0");
const now = () => Date.now() - 1_000;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const blob = (text: string) => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0${text}`).digest("hex");
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
}

function repo() {
  const sb = sandbox();
  cleanups.push(() => sb.cleanup());
  const recordFile = engineFolder(gitText(sb.repo, ["rev-parse", "--absolute-git-dir"])).recordFile;
  return { ...sb, recordFile };
}

function engine(): BackupEngine {
  return createBackupEngine({ machineId: "lane-test", ...permissiveGuards, gitEnv: isolatedGitEnv, settleMs: 5 });
}

function put(root: string, path: string, content: string): void {
  const abs = join(root, ...path.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** An injected observer answering per pid; nothing real is observed. */
function observer(answers: Record<number, ProcessObservation> = {}): ProcessObserver {
  return { startTime: async () => null, observe: async (pid) => answers[pid] ?? "unknown" };
}

interface LaneOptions {
  vaults: Array<{ id: string; path: string; receipts: ReceiptsApi | null; recordFile: string | null; include?: string[]; exclude?: string[] }>;
  identity?: HelperIncarnation | null;
  observer?: ProcessObserver;
  priorShutdown?: PriorShutdownEvidence | null;
  workers?: VaultWorker[];
  stopping?: () => boolean;
}

/** A connection server over a private local socket, as the helper builds it, with the given lane context. */
async function lane(options: LaneOptions) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "s")));
  const path = join(dir, "h");
  const vaults = new Map<string, ReceiptVault>(options.vaults.map((v) => {
    const scope = { include: v.include ?? ["notes"], exclude: v.exclude ?? [] };
    return [v.id, { vault: { id: v.id, path: v.path, scope, remote: "origin" }, scope: compileScope(scope), receipts: v.receipts, recordFile: v.recordFile }];
  }));
  const tracked = new Set<Promise<unknown>>();
  const stopping = options.stopping ?? (() => false);
  const ctx: ReceiptLaneContext = {
    vaults, helperVersion: HELPER_VERSION, identity: async () => (options.identity === undefined ? H1 : options.identity), exclusive: () => !stopping(), stopping,
    observer: options.observer ?? observer(), priorShutdown: options.priorShutdown ?? null, now,
    track: (_vault, work) => {
      const entry = work.then(() => undefined, () => undefined).finally(() => tracked.delete(entry));
      tracked.add(entry);
      return work;
    },
  };
  const workers = new Map((options.workers ?? []).map((w) => [w.id, w]));
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    serveConnection(socket, { workers, stopping, startedAt: 1, timers: systemTimers, helperVersion: HELPER_VERSION, receipts: ctx });
  });
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(path, res);
  });
  cleanups.push(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((res) => server.close(() => res()));
    rmSync(dir, { recursive: true, force: true });
  });
  return { path, tracked, sockets };
}

async function client(path: string, epoch: number, writer: WriterIncarnation | null, clientId = CLIENT): Promise<ReceiptsClient> {
  const c = await connectReceipts(path, { client: "lane-test", clientId, clientEpoch: epoch, writer, timeoutMs: 5_000 });
  cleanups.push(() => c.close());
  return c;
}

const fresh = { vault: "v", knownRecordId: null, knownStreamId: null, nextSeq: 1, ackedThrough: 0 };
const ok = <T>(reply: { ok: true; result: T } | { ok: false; error: { code: string; message: string } }): T => {
  if (!reply.ok) throw new Error(`expected a result, got ${reply.error.code}: ${reply.error.message}`);
  return reply.result;
};
const errorCode = (reply: { ok: boolean; error?: { code: string } }) => (reply.ok ? "ok" : reply.error!.code);
const fileHash = (file: string) => (existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : "absent");
const edit = (seq: number, path: string, throughGen: number, extra: Record<string, unknown> = {}) => ({ method: "noteEdit" as const, vault: "v", seq, ackedThrough: 0, path, doc: doc4, throughGen, at: now(), ...extra });

function worker(id: string, syncNow: () => Promise<CycleReport>): VaultWorker {
  return {
    id, start: () => undefined, syncNow, stop: async () => undefined, unsettled: () => [],
    status: async () => ({ vault: id, summary: "unknown", uncertainty: [], helper: { state: "idle", cycleStartedAt: null, nextDueAt: null, lastCycle: null }, fresh: false, engineObservedAt: null, engine: null, statusError: null }),
  };
}

describe("receipts lane with a real engine", () => {
  test("a held syncNow on a control connection does not delay receipts (CX-S9a)", async () => {
    const r = repo();
    const held = gate();
    const l = await lane({
      vaults: [{ id: "v", path: r.repo, receipts: engine().receipts, recordFile: r.recordFile }],
      workers: [worker("v", async () => { await held.promise; return { vault: "v", reason: "syncNow", startedAt: 1, finishedAt: 2, outcome: "no-snapshot", capture: null, push: null, verify: null, block: null, error: null }; })],
    });
    const control = await connectHelper(l.path, { client: "control" });
    cleanups.push(() => control.close());
    const sync = control.request("syncNow", { vault: "v" }, 20_000);
    await pause(50);
    const c = await client(l.path, 4, W4);
    const started = Date.now();
    ok(await c.openStream(fresh));
    expect(ok(await c.send(edit(1, "notes/a.md", 1)))).toMatchObject({ seq: 1, ok: "edit", epoch: 4 });
    expect(Date.now() - started).toBeLessThan(2_000);
    held.open();
    expect(await sync).toMatchObject({ ok: true, result: { outcome: "no-snapshot" } });
  });

  test("edit, flush, capture and verify: the proof follows the exact blob to a verified row", async () => {
    const r = repo();
    const e = engine();
    await e.enable(r.repo);
    put(r.repo, "notes/a.md", "saved text\n");
    const l = await lane({ vaults: [{ id: "v", path: r.repo, receipts: e.receipts, recordFile: r.recordFile }] });
    const c = await client(l.path, 4, W4);
    const opened = ok(await c.openStream(fresh));
    expect(opened).toMatchObject({ rebased: true, base: 0, appliedThrough: 0, ackedThrough: 0, objectFormat: "sha1" });
    expect(c.stream("v")).toEqual({ recordId: opened.recordId, streamId: opened.streamId });
    ok(await c.send(edit(1, "notes/a.md", 1)));
    const flushed = ok(await c.send({ method: "noteFlush", vault: "v", seq: 2, ackedThrough: 1, path: "notes/a.md", doc: doc4, gen: 1, intent: intent(1), editRef: 1, writeRef: null, blobOid: blob("saved text\n") }));
    expect(flushed).toMatchObject({ ok: "flushed", endedWrite: false });
    const want = [{ path: "notes/a.md", doc: doc4 }];
    expect(ok(await c.status("v", want)).docs.items[0]).toMatchObject({ state: "registered", flushed: { gen: 1, blobOid: blob("saved text\n") } });
    await e.capture(r.repo, { include: ["notes"] });
    expect(ok(await c.status("v", want)).docs.items[0]).toMatchObject({ state: "captured" });
    expect((await e.pushBackup(r.repo)).state).toBe("pushed");
    expect((await e.verify(r.repo)).verified).toBe(true);
    const after = ok(await c.status("v", want));
    expect(after.docs.items[0]).toMatchObject({ state: "verified", verified: { gen: 1, blobOid: blob("saved text\n") } });
    expect(after.thisClient.blobDebt.count).toBe(0);
  });

  test("lost reply: outcome-unknown, then the identical resend returns the one stored effect; another body at that seq conflicts", async () => {
    const r = repo();
    const l = await lane({ vaults: [{ id: "v", path: r.repo, receipts: engine().receipts, recordFile: r.recordFile }] });
    const c = await client(l.path, 4, W4);
    ok(await c.openStream(fresh));
    const body = edit(1, "notes/a.md", 1);
    let injected = false;
    receiptTestHooks.beforeReply = () => {
      if (!injected) {
        injected = true;
        throw new Error("injected lost reply");
      }
    };
    expect(errorCode(await c.send(body))).toBe("outcome-unknown");
    const generation = () => JSON.parse(readFileSync(r.recordFile, "utf8")).generation as number;
    const before = generation();
    const replay = ok(await c.send(body));
    expect(replay).toMatchObject({ seq: 1, ok: "edit", epoch: 4 });
    expect(generation()).toBe(before);
    expect(errorCode(await c.send({ ...body, throughGen: 2 }))).toBe("conflict");
  });

  test("an absent stream opens at seq 20; retired, out-of-order and acknowledgement watermarks hold across connections", async () => {
    const r = repo();
    const l = await lane({ vaults: [{ id: "v", path: r.repo, receipts: engine().receipts, recordFile: r.recordFile }] });
    const a = await client(l.path, 4, W4);
    const opened = ok(await a.openStream({ ...fresh, nextSeq: 21, ackedThrough: 7 }));
    expect(opened).toMatchObject({ rebased: true, base: 20, appliedThrough: 20, ackedThrough: 20 });
    expect(errorCode(await a.send(edit(20, "notes/a.md", 1)))).toBe("retired");
    expect(errorCode(await a.send(edit(22, "notes/a.md", 1)))).toBe("out-of-order");
    const first = edit(21, "notes/a.md", 1);
    const applied = ok(await a.send(first));
    // A second connection of the same process rejoins with the identities and acknowledges seq 21.
    const b = await client(l.path, 4, W4);
    expect(errorCode(await b.openStream({ ...fresh, nextSeq: 22 }))).toBe("stream-required");
    const rejoined = ok(await b.openStream({ vault: "v", knownRecordId: opened.recordId, knownStreamId: opened.streamId, nextSeq: 22, ackedThrough: 21 }));
    expect(rejoined).toMatchObject({ rebased: false, appliedThrough: 21, ackedThrough: 21 });
    // A delayed duplicate with a lower acknowledgement cannot lower the watermark or reapply.
    expect(errorCode(await a.send({ ...first, ackedThrough: 0 }))).toBe("retired");
    expect(applied.seq).toBe(21);
    const view = ok(await b.status("v", []));
    expect(view.stream).toMatchObject({ base: 20, appliedThrough: 21, ackedThrough: 21 });
  });

  test("restart: an old applied write start replays as the original epoch-4 result; an unapplied old start is cached stale; gone release needs an exact gone writer", async () => {
    const r = repo();
    const e = engine();
    const answers: Record<number, ProcessObservation> = {};
    const l = await lane({ vaults: [{ id: "v", path: r.repo, receipts: e.receipts, recordFile: r.recordFile }], observer: observer(answers) });
    const old = await client(l.path, 4, W4);
    const opened = ok(await old.openStream(fresh));
    ok(await old.send(edit(1, "notes/a.md", 1)));
    const start = { method: "noteWriteStart" as const, vault: "v", seq: 2, ackedThrough: 0, path: "notes/a.md", doc: doc4, gen: 1, intent: intent(2), writer: W4, at: now() };
    const started = ok(await old.send(start));
    expect(started).toMatchObject({ ok: "write-started", epoch: 4 });
    old.close();

    const next = await client(l.path, 5, W5);
    ok(await next.openStream({ vault: "v", knownRecordId: opened.recordId, knownStreamId: opened.streamId, nextSeq: 3, ackedThrough: 0 }));
    // The replayed old start returns exactly what epoch 4 stored: epoch 4, not an authorisation for this process.
    expect(ok(await next.send(start))).toEqual(started);
    const oldUnsent = { ...start, seq: 3, path: "notes/b.md", intent: intent(3) };
    expect(ok(await next.send(oldUnsent))).toMatchObject({ seq: 3, refused: "stale-writer", epoch: 5 });

    const want = [{ path: "notes/a.md", doc: doc4 }];
    answers[W4.pid] = "unknown";
    let view = ok(await next.status("v", want));
    expect(view.vault.activeWrites.thisClient.count).toBe(1);
    expect(view.docs.items[0]!.activeWrite).toBe(true);
    answers[W4.pid] = "there";
    expect(ok(await next.status("v", want)).vault.activeWrites.thisClient.count).toBe(1);
    answers[W4.pid] = "gone";
    view = ok(await next.status("v", want));
    expect(view.vault.activeWrites.thisClient.count).toBe(0);
    expect(view.docs.items[0]!.activeWrite).toBe(false);
    expect(JSON.parse(readFileSync(r.recordFile, "utf8")).writes["notes/a.md"].active).toBe(false);
  });

  test("a linked worktree registered as the vault keeps its receipts in that worktree's own engine folder", async () => {
    const r = repo();
    git(r.repo, ["commit", "-q", "--allow-empty", "-m", "init"]);
    const linked = join(r.dir, "linked");
    git(r.repo, ["worktree", "add", "-q", "-b", "side", linked]);
    const linkedReal = realpathSync(linked);
    const recordFile = engineFolder(gitText(linkedReal, ["rev-parse", "--absolute-git-dir"])).recordFile;
    expect(recordFile).not.toBe(r.recordFile);
    const l = await lane({ vaults: [{ id: "v", path: linkedReal, receipts: engine().receipts, recordFile }] });
    const c = await client(l.path, 4, W4);
    ok(await c.openStream(fresh));
    ok(await c.send(edit(1, "notes/a.md", 1)));
    expect(existsSync(recordFile)).toBe(true);
    expect(existsSync(r.recordFile)).toBe(false);
  });

  test("registered scope and vault only: refusals change nothing", async () => {
    const r = repo();
    const l = await lane({ vaults: [{ id: "v", path: r.repo, receipts: engine().receipts, recordFile: r.recordFile, include: ["notes"], exclude: ["notes/private"] }] });
    const c = await client(l.path, 4, W4);
    ok(await c.openStream(fresh));
    const before = fileHash(r.recordFile);
    for (const path of ["other/a.md", "notes/private/x.md", ".git/config", "notes2/a.md"]) expect(errorCode(await c.send(edit(1, path, 1)))).toBe("out-of-scope");
    expect(errorCode(await c.status("v", [{ path: "other/a.md", doc: doc4 }]))).toBe("out-of-scope");
    expect(errorCode(await c.send({ ...edit(1, "notes/a.md", 1), vault: "nope" }))).toBe("unknown-vault");
    expect(fileHash(r.recordFile)).toBe(before);
    expect(ok(await c.send(edit(1, "notes/a.md", 1)))).toMatchObject({ seq: 1 });
  });

  test("two connections of one client share one stream and one seq order (CX-S9c)", async () => {
    const r = repo();
    const l = await lane({ vaults: [{ id: "v", path: r.repo, receipts: engine().receipts, recordFile: r.recordFile }] });
    const a = await client(l.path, 4, W4);
    const opened = ok(await a.openStream(fresh));
    const b = await client(l.path, 4, W4);
    ok(await b.openStream({ vault: "v", knownRecordId: opened.recordId, knownStreamId: opened.streamId, nextSeq: 1, ackedThrough: 0 }));
    ok(await a.send(edit(1, "notes/a.md", 1)));
    ok(await b.send(edit(2, "notes/a.md", 2)));
    ok(await a.send(edit(3, "notes/a.md", 3, { ackedThrough: 2 })));
    expect(errorCode(await b.send(edit(5, "notes/a.md", 5, { ackedThrough: 2 })))).toBe("out-of-order");
    expect(errorCode(await b.send(edit(4, "notes/a.md", 4, { ackedThrough: 2 })))).toBe("ok");
  });

  test("activation: a second helper is refused while the first is there or unknown, admitted when it is gone, and the first cannot alternate back", async () => {
    const r = repo();
    const e = engine();
    const first = await lane({ vaults: [{ id: "v", path: r.repo, receipts: e.receipts, recordFile: r.recordFile }], identity: H1 });
    const c1 = await client(first.path, 4, W4);
    const opened = ok(await c1.openStream(fresh));
    const known = { vault: "v", knownRecordId: opened.recordId, knownStreamId: opened.streamId, nextSeq: 1, ackedThrough: 0 };

    const answers: Record<number, ProcessObservation> = { [H1.pid]: "there" };
    const second = await lane({ vaults: [{ id: "v", path: r.repo, receipts: e.receipts, recordFile: r.recordFile }], identity: H2, observer: observer(answers) });
    const c2 = await client(second.path, 4, W4);
    const before = fileHash(r.recordFile);
    expect(errorCode(await c2.openStream(known))).toBe("activation-refused");
    answers[H1.pid] = "unknown";
    expect(errorCode(await c2.openStream(known))).toBe("activation-refused");
    expect(fileHash(r.recordFile)).toBe(before);
    answers[H1.pid] = "gone";
    ok(await c2.openStream(known));
    expect(errorCode(await c1.send(edit(1, "notes/a.md", 1)))).toBe("activation-refused");
    expect(ok(await c2.status("v", [])).activation).toMatchObject({ by: H2, handovers: 1 });

    // A third helper with H2's exact sealed shutdown report takes over without observing anything.
    const third = await lane({
      vaults: [{ id: "v", path: r.repo, receipts: e.receipts, recordFile: r.recordFile }], identity: H3, observer: observer({ [H2.pid]: "there" }),
      priorShutdown: { by: H2, report: { work: "ended", socket: "removed", claims: "released" } },
    });
    const c3 = await client(third.path, 4, W4);
    ok(await c3.openStream(known));
    expect(ok(await c3.status("v", [])).activation).toMatchObject({ by: H3, handovers: 2 });

    // No readable start time of its own: no incarnation, no activation.
    const blind = await lane({ vaults: [{ id: "v", path: r.repo, receipts: e.receipts, recordFile: r.recordFile }], identity: null });
    const c4 = await client(blind.path, 4, W4);
    expect(errorCode(await c4.openStream(known))).toBe("activation-refused");
  });

  test("a newer process supersedes an older one's connection; the older connection is closed", async () => {
    const r = repo();
    const l = await lane({ vaults: [{ id: "v", path: r.repo, receipts: engine().receipts, recordFile: r.recordFile }] });
    const older = await client(l.path, 4, W4);
    const opened = ok(await older.openStream(fresh));
    const newer = await client(l.path, 5, W5);
    ok(await newer.openStream({ vault: "v", knownRecordId: opened.recordId, knownStreamId: opened.streamId, nextSeq: 1, ackedThrough: 0 }));
    expect(errorCode(await older.send(edit(1, "notes/a.md", 1)))).toBe("superseded");
    expect(await older.closed).toBeInstanceOf(Error);
  });

  test("other clients appear only as counts and times; a full want list is answered row for row", async () => {
    const r = repo();
    const l = await lane({ vaults: [{ id: "v", path: r.repo, receipts: engine().receipts, recordFile: r.recordFile }] });
    const other = await client(l.path, 4, W4, OTHER);
    ok(await other.openStream(fresh));
    ok(await other.send(edit(1, "notes/private-of-other.md", 1)));
    const mine = await client(l.path, 4, W4);
    ok(await mine.openStream(fresh));
    ok(await mine.send(edit(1, "notes/a.md", 1)));
    const want = Array.from({ length: 64 }, (_, i) => ({ path: `notes/doc-${i}.md`, doc: doc4 }));
    want[0] = { path: "notes/a.md", doc: doc4 };
    const reply = await mine.status("v", want);
    const view = ok(reply);
    expect(view.docs).toMatchObject({ count: 64, omitted: 0 });
    expect(view.docs.items[0]!.state).toBe("debt");
    expect(view.docs.items[1]!.state).toBe("none");
    expect(view.vault.otherClientDebt).toMatchObject({ count: 1, clients: 1 });
    expect(JSON.stringify(view)).not.toContain("private-of-other");
  });
});

describe("receipts lane without an engine call", () => {
  /** A receipt API whose calls wait for `held` (and record what they were asked). */
  function heldApi(held: Promise<void>) {
    const calls: string[] = [];
    const api = {
      openStream: async () => { calls.push("openStream"); await held; return { error: "busy", message: "held" }; },
      apply: async () => { calls.push("apply"); await held; return { error: "busy", message: "held" }; },
      status: async () => { calls.push("status"); await held; return { error: "busy", message: "held" }; },
      releaseGoneWriters: async () => { calls.push("release"); return { released: [] }; },
    } as unknown as ReceiptsApi;
    return { api, calls };
  }

  /** A real folder that is its own real path, as a registered vault's must be; nothing is written in it. */
  function folder(): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "v")));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  test("work is tracked until it settles; a stopping helper refuses new receipts", async () => {
    const held = gate();
    const { api, calls } = heldApi(held.promise);
    let stopping = false;
    const l = await lane({ vaults: [{ id: "v", path: folder(), receipts: api, recordFile: null }], stopping: () => stopping });
    const c = await client(l.path, 4, W4);
    const pending = c.send(edit(1, "notes/a.md", 1));
    await pause(50);
    expect(l.tracked.size).toBe(1);
    stopping = true;
    held.open();
    expect(errorCode(await pending)).toBe("busy");
    expect(l.tracked.size).toBe(0);
    expect(errorCode(await c.send(edit(1, "notes/a.md", 1)))).toBe("stopping");
    expect(calls).toEqual(["apply"]);
  });

  test("the work tracker settles only when every tracked request has, including one added while it waits", async () => {
    const tracker = createWorkTracker();
    const first = gate();
    const second = gate();
    void tracker.track("v", first.promise);
    let settled = false;
    const waiting = tracker.settled().then(() => { settled = true; });
    expect(tracker.busy()).toEqual(["v"]);
    tracker.track("w", second.promise.then(() => { throw new Error("a failed request still settles"); })).catch(() => undefined);
    first.open();
    await pause(20);
    expect(settled).toBe(false);
    expect(tracker.busy()).toEqual(["w"]);
    second.open();
    await waiting;
    expect(tracker.busy()).toEqual([]);
  });

  test("more than eight waiting requests close the connection, as on a control connection", async () => {
    const held = gate();
    const { api } = heldApi(held.promise);
    const l = await lane({ vaults: [{ id: "v", path: folder(), receipts: api, recordFile: null }] });
    const lines = [JSON.stringify({ type: "hello", protocol: 2, lane: "receipts", client: "x", clientId: CLIENT, clientEpoch: 4, writer: null, capabilities: ["receipts-2"] })];
    for (let i = 0; i < 10; i++) lines.push(JSON.stringify({ id: i + 1, ...edit(i + 1, "notes/a.md", 1) }));
    const answers = await rawExchange(l.path, `${lines.join("\n")}\n`);
    held.open();
    expect(answers[0]).toMatchObject({ type: "hello", ok: true, protocol: 2, lane: "receipts", engineLevel: 1 });
    expect(answers.at(-1)).toEqual({ id: null, ok: false, error: { code: "bad-request", message: "too many queued requests on this connection" } });
  });

  test("a malformed receipts hello is refused in protocol 2's terms; a lane-less protocol-2 hello gets protocol 1's refusal", async () => {
    const l = await lane({ vaults: [] });
    const bad = await rawExchange(l.path, `${JSON.stringify({ type: "hello", protocol: 2, lane: "receipts", client: "x", clientId: CLIENT, clientEpoch: 0, writer: null, capabilities: ["receipts-2"] })}\n`);
    expect(bad).toEqual([{ type: "hello", ok: false, protocol: 2, error: { code: "bad-request", message: "clientEpoch must be a positive integer" } }]);
    const old = await rawExchange(l.path, `${JSON.stringify({ type: "hello", protocol: 2, client: "old-app" })}\n`);
    expect(old).toEqual([{ type: "hello", ok: false, protocol: 1, error: { code: "protocol-mismatch", message: "this helper speaks protocol 1" } }]);
  });
});

/** Sends raw bytes and collects every JSON line until the server closes the connection. */
function rawExchange(socketPath: string, payload: string): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let data = "";
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (c) => { data += c.toString(); });
    socket.on("error", reject);
    socket.on("close", () => resolve(data.split("\n").filter(Boolean).map((l) => JSON.parse(l))));
    setTimeout(() => socket.destroy(), 3_000);
  });
}

describe("receipts client settles every request", () => {
  /** A disposable peer: `answer` gets each received message and its index (0 is the hello). */
  async function peer(answer: (socket: Socket, index: number, message: Record<string, unknown>) => void) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "s")));
    const path = join(dir, "h");
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => undefined);
      let data = "";
      let index = 0;
      socket.on("data", (chunk) => {
        data += chunk.toString();
        for (let end = data.indexOf("\n"); end >= 0; end = data.indexOf("\n")) {
          const line = data.slice(0, end);
          data = data.slice(end + 1);
          answer(socket, index++, JSON.parse(line));
        }
      });
    });
    await new Promise<void>((res, rej) => {
      server.once("error", rej);
      server.listen(path, res);
    });
    cleanups.push(async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((res) => server.close(() => res()));
      rmSync(dir, { recursive: true, force: true });
    });
    return { path, sockets };
  }
  const helloOk = `${JSON.stringify({ type: "hello", ok: true, protocol: 2, lane: "receipts", helperVersion: "0.2.0", engineLevel: 1, capabilities: ["receipts-2"] })}\n`;
  const connectTo = (path: string, timeoutMs = 300) => connectReceipts(path, { client: "t", clientId: CLIENT, clientEpoch: 4, writer: W4, timeoutMs });
  const failure = (p: Promise<unknown>) => p.then(() => "resolved", (e: unknown) => (e instanceof ReceiptsClientError ? `${e.code}:${e.sent}` : `other:${String(e)}`));

  test("hello: an old helper's refusal is unavailable; another engine level or an old version is a bad reply", async () => {
    const old = await peer((s, i) => { if (i === 0) s.write(`${JSON.stringify({ type: "hello", ok: false, protocol: 1, error: { code: "protocol-mismatch", message: "this helper speaks protocol 1" } })}\n`); });
    expect(await failure(connectTo(old.path))).toBe("unavailable:true");
    const level = await peer((s, i) => { if (i === 0) s.write(helloOk.replace('"engineLevel":1', '"engineLevel":2')); });
    expect(await failure(connectTo(level.path))).toBe("bad-reply:true");
    const silent = await peer(() => undefined);
    expect(await failure(connectTo(silent.path, 50))).toBe("timeout:true");
  });

  test("a malformed reply, a wrong id, a timeout or a closed socket after sending is outcome-unknown; later requests are not sent", async () => {
    const malformed = await peer((s, i, m) => s.write(i === 0 ? helloOk : `${JSON.stringify({ id: m.id, ok: true, result: { seq: 1 } })}\n`));
    const c1 = await connectTo(malformed.path);
    expect(await failure(c1.openStream(fresh))).toBe("outcome-unknown:true");
    expect(await failure(c1.send(edit(1, "notes/a.md", 1)))).toBe("not-sent:false");

    const wrongId = await peer((s, i, m) => s.write(i === 0 ? helloOk : `${JSON.stringify({ id: (m.id as number) + 1, ok: false, error: { code: "busy", message: "x" } })}\n`));
    const c2 = await connectTo(wrongId.path);
    expect(await failure(c2.send(edit(1, "notes/a.md", 1)))).toBe("outcome-unknown:true");

    const silent = await peer((s, i) => { if (i === 0) s.write(helloOk); });
    const c3 = await connectTo(silent.path, 100);
    const timedOut = failure(c3.send(edit(1, "notes/a.md", 1)));
    const queued = failure(c3.send(edit(2, "notes/a.md", 2)));
    expect(await timedOut).toBe("outcome-unknown:true");
    expect(await queued).toBe("not-sent:false");

    const closing = await peer((s, i) => (i === 0 ? s.write(helloOk) : s.destroy()));
    const c4 = await connectTo(closing.path);
    expect(await failure(c4.send(edit(1, "notes/a.md", 1)))).toBe("outcome-unknown:true");
    expect(await c4.closed).toBeInstanceOf(Error);

    const statusSilent = await peer((s, i) => { if (i === 0) s.write(helloOk); });
    const c5 = await connectTo(statusSilent.path, 100);
    expect(await failure(c5.status("v", []))).toBe("timeout:true");
  });

  test("cancellation, queue bound and line bound: not sent; an unasked-for line closes the connection", async () => {
    const quiet = await peer((s, i) => { if (i === 0) s.write(helloOk); });
    const c = await connectTo(quiet.path, 2_000);
    const aborted = new AbortController();
    aborted.abort();
    expect(await failure(c.send(edit(1, "notes/a.md", 1), { signal: aborted.signal }))).toBe("not-sent:false");
    const tooLong = Array.from({ length: 64 }, (_, i) => ({ path: `notes/${"x".repeat(1_000)}-${i}.md`, doc: doc4 }));
    expect(await failure(c.status("v", tooLong))).toBe("not-sent:false");
    const waiting = Array.from({ length: 8 }, (_, i) => failure(c.send(edit(i + 1, "notes/a.md", 1))));
    expect(await failure(c.send(edit(9, "notes/a.md", 1)))).toBe("not-sent:false");
    c.close();
    expect((await Promise.all(waiting))[0]).toBe("outcome-unknown:true");
    expect(new Set((await Promise.all(waiting)).slice(1))).toEqual(new Set(["not-sent:false"]));

    const chatty = await peer((s, i) => { if (i === 0) s.write(`${helloOk}${JSON.stringify({ id: 99, ok: true, result: {} })}\n`); });
    const noisy = await connectTo(chatty.path);
    expect(await noisy.closed).toBeInstanceOf(Error);
    expect(await failure(noisy.send(edit(1, "notes/a.md", 1)))).toBe("not-sent:false");
  });

  test("cancelling after sending closes the connection and leaves the outcome unknown", async () => {
    const quiet = await peer((s, i) => { if (i === 0) s.write(helloOk); });
    const c = await connectTo(quiet.path, 2_000);
    const abort = new AbortController();
    const sent = failure(c.send(edit(1, "notes/a.md", 1), { signal: abort.signal }));
    await pause(30);
    abort.abort();
    expect(await sent).toBe("outcome-unknown:true");
    expect(await c.closed).toBeInstanceOf(Error);
  });
});
