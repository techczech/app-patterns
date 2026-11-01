/**
 * Boundaries the independent E2 review found open (F1-F6), each tested at the seam it changed: the process
 * judgement, the receipt session's path and ownership fences around every await before an engine call,
 * the client's captured identities and per-call deadlines, and the status validator. Real disposable
 * engines and Git checkouts, real local sockets; every process observation is injected, and nothing here
 * starts, inspects or signals a real process other than Git for the fixtures.
 */
import { setDefaultTimeout, afterEach, describe, expect, test } from "bun:test";
setDefaultTimeout(30_000);
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackupEngine } from "../engine.ts";
import type { ReceiptsApi } from "../engine-receipts.ts";
import { engineFolder } from "../engine-store.ts";
import type { HelperIncarnation, WriterIncarnation } from "../receipt-ledger.ts";
import { receiptStatusView, type ReceiptStatusView } from "../receipt-status.ts";
import type { ReceiptSession } from "../receipt-transitions.ts";
import { compileScope } from "../scope.ts";
import { gitText, isolatedGitEnv, permissiveGuards, sandbox } from "../test-fixtures.ts";
import { attest, goneWriterProofs } from "./activation.ts";
import { judge, type ProcessObservation, type ProcessObserver } from "./process-observer.ts";
import { connectReceipts, ReceiptsClientError } from "./receipt-client.ts";
import { checkReceiptStatusView, LaneError } from "./receipt-protocol.ts";
import { createWorkTracker, openReceiptLane } from "./receipt-session.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const HOST = "fixture";
const H1: HelperIncarnation = { host: HOST, pid: 4001, startedAt: 1_700_000_000_000, helperVersion: "0.2.0" };
const H2: HelperIncarnation = { ...H1, pid: 4002 };
const W: WriterIncarnation = { host: HOST, pid: 5001, startedAt: 1_700_000_000_000, clientEpoch: 4 };
const CLIENT = "c".repeat(32);
const DOC = { owner: "a".repeat(32), ownerEpoch: 4, docEpoch: 1 };
const INTENT = "b".repeat(32);
const hello = { type: "hello" as const, protocol: 2 as const, lane: "receipts" as const, client: "boundaries", clientId: CLIENT, clientEpoch: 4, writer: { ...W, pid: 5002 }, capabilities: ["receipts-2"] as ["receipts-2"] };
const fresh = { id: 1, method: "openStream", vault: "v", knownRecordId: null, knownStreamId: null, nextSeq: 1, ackedThrough: 0 };
const now = () => Date.now() - 1_000;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fileHash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const record = (file: string) => JSON.parse(readFileSync(file, "utf8"));
function gate<T = void>() {
  let open!: (v: T) => void;
  const promise = new Promise<T>((r) => { open = r; });
  return { promise, open };
}
const replyOf = async (p: Promise<{ reply: string }>) => JSON.parse((await p).reply);

function checkout() {
  const sb = sandbox();
  cleanups.push(() => sb.cleanup());
  const e = createBackupEngine({ machineId: "boundaries", ...permissiveGuards, gitEnv: isolatedGitEnv, settleMs: 5 });
  return { ...sb, e, recordFile: engineFolder(gitText(sb.repo, ["rev-parse", "--absolute-git-dir"])).recordFile };
}
type Checkout = ReturnType<typeof checkout>;

/** Activates `c` directly through the engine for H1 and returns its session. */
async function activate(c: Checkout): Promise<ReceiptSession> {
  const session: ReceiptSession = { helper: H1, clientId: CLIENT, clientEpoch: 4, writer: W, recordId: null, streamId: null };
  const out = await c.e.receipts.openStream(c.repo, session, { helper: H1, exclusive: true, prior: null }, { ...fresh, method: "openStream" } as never);
  if ("error" in out) throw new Error(`fixture activation failed: ${out.error}`);
  return { ...session, recordId: out.recordId, streamId: out.streamId };
}
async function writeStart(c: Checkout, session: ReceiptSession, path: string) {
  const out = await c.e.receipts.apply(c.repo, session, { id: 2, method: "noteWriteStart", vault: "v", seq: 1, ackedThrough: 0, path, doc: DOC, gen: 1, intent: INTENT, writer: W, at: now() } as never);
  expect(out).toMatchObject({ ok: "write-started" });
}

/** A receipt lane for checkout `c` as helper H2, with injected observations and ownership. */
function laneFor(c: Checkout, observer: ProcessObserver, exclusive = () => true, stopping = () => false, receipts: ReceiptsApi = c.e.receipts) {
  const tracker = createWorkTracker();
  const scope = { include: ["notes"] };
  return openReceiptLane(hello, {
    vaults: new Map([["v", { vault: { id: "v", path: c.repo, scope, remote: "origin" }, scope: compileScope(scope), receipts, recordFile: c.recordFile }]]),
    helperVersion: "0.2.0", identity: async () => H2, exclusive, stopping, observer, priorShutdown: null, track: tracker.track, now,
  });
}
const answers = (byPid: Record<number, ProcessObservation>): ProcessObserver => ({ startTime: async () => null, observe: async (pid) => byPid[pid] ?? "unknown" });
/** Replaces the registered folder of `a` with a link to `b`'s checkout. */
function retarget(a: Checkout, b: Checkout): string {
  const moved = `${a.repo}-moved`;
  renameSync(a.repo, moved);
  symlinkSync(b.repo, a.repo);
  return moved;
}

describe("F1: a live process whose start time reads differently is never shown gone", () => {
  test("any unequal start time is unknown; only no such process is gone; unknown attests nothing and proves nothing", async () => {
    for (const shift of [1, 999, 2_001, 10_000, 86_400_000, -10_000]) expect(judge(true, W.startedAt, W.startedAt + shift)).toBe("unknown");
    expect(judge(true, W.startedAt, W.startedAt)).toBe("there");
    expect(judge(false, W.startedAt, null)).toBe("gone");
    const shifted = judge(true, W.startedAt, W.startedAt + 10_000);
    const observer: ProcessObserver = { startTime: async () => null, observe: async () => shifted };
    expect(await attest(H2, H1, null, observer)).toHaveProperty("refused");
    const hint = { activation: H1, marks: [{ path: "notes/a.md", gen: 9, owner: { clientId: CLIENT, writer: W, doc: DOC, path: "notes/a.md", seq: 2, intent: INTENT } }] };
    expect(await goneWriterProofs(hint as never, CLIENT, { ...W, pid: 5002 }, H2, observer, now)).toEqual([]);
  });
});

describe("F2: the registered folder is checked again after every await before an engine call", () => {
  test("a folder replaced while the prior helper is observed is refused; neither checkout's activation changes", async () => {
    const a = checkout();
    const b = checkout();
    await activate(a);
    const bs = await activate(b);
    const entered = gate();
    const resume = gate();
    const lane = laneFor(a, { startTime: async () => null, observe: async () => { entered.open(); await resume.promise; return "gone"; } });
    const pending = replyOf(lane.handle(JSON.stringify({ ...fresh, knownRecordId: bs.recordId, knownStreamId: bs.streamId })));
    await entered.promise;
    const bBefore = fileHash(b.recordFile);
    const moved = retarget(a, b);
    resume.open();
    const out = await pending;
    expect(out).toMatchObject({ ok: false, error: { code: "activation-refused" } });
    expect(fileHash(b.recordFile)).toBe(bBefore);
    expect(record(b.recordFile).receipts.activation.by.pid).toBe(H1.pid);
    expect(record(join(moved, ".git/vault-sync/deadline.json")).receipts.activation.by.pid).toBe(H1.pid);
  });

  test("after its stream is open, a connection cannot read status of, release guards in or send receipts to a replacement folder", async () => {
    const a = checkout();
    const b = checkout();
    const lane = laneFor(a, answers({ [W.pid]: "gone" }));
    expect((await replyOf(lane.handle(JSON.stringify(fresh)))).ok).toBe(true);
    const bs = await activate(b);
    await writeStart(b, bs, "notes/a.md");
    const bBefore = fileHash(b.recordFile);
    retarget(a, b);
    // The hint now reads B's record and W is observed gone: without the fence B's guard would be released.
    const status = await replyOf(lane.handle(JSON.stringify({ id: 3, method: "receiptStatus", vault: "v", want: [] })));
    expect(status).toMatchObject({ ok: false, error: { code: "activation-refused" } });
    const edit = await replyOf(lane.handle(JSON.stringify({ id: 4, method: "noteEdit", vault: "v", seq: 1, ackedThrough: 0, path: "notes/a.md", doc: DOC, throughGen: 1, at: now() })));
    expect(edit).toMatchObject({ ok: false, error: { code: "activation-refused" } });
    expect(fileHash(b.recordFile)).toBe(bBefore);
    expect(record(b.recordFile).writes["notes/a.md"].active).toBe(true);
  });
});

describe("F3: a gone-writer release needs exclusive ownership immediately before it", () => {
  for (const [name, stops] of [["stopping", true], ["a lost claim", false]] as const) {
    test(`${name} during the observation keeps every guard`, async () => {
      const c = checkout();
      let exclusive = true;
      let stopping = false;
      const observer: ProcessObserver = { startTime: async () => null, observe: async () => { exclusive = false; stopping = stops; return "gone"; } };
      const lane = laneFor(c, observer, () => exclusive, () => stopping);
      expect((await replyOf(lane.handle(JSON.stringify(fresh)))).ok).toBe(true);
      const own = record(c.recordFile).receipts;
      await writeStart(c, { helper: H2, clientId: CLIENT, clientEpoch: 4, writer: W, recordId: own.recordId, streamId: own.clients[CLIENT].streamId }, "notes/a.md");
      const before = fileHash(c.recordFile);
      const out = await replyOf(lane.handle(JSON.stringify({ id: 3, method: "receiptStatus", vault: "v", want: [] })));
      expect(out).toMatchObject({ ok: false, error: { code: stops ? "stopping" : "activation-refused" } });
      expect(record(c.recordFile).writes["notes/a.md"].active).toBe(true);
      expect(fileHash(c.recordFile)).toBe(before);
    });
  }

  test("with ownership held, the same gone writer is released (the fence is not a blanket refusal)", async () => {
    const c = checkout();
    const lane = laneFor(c, answers({ [W.pid]: "gone" }));
    expect((await replyOf(lane.handle(JSON.stringify(fresh)))).ok).toBe(true);
    const own = record(c.recordFile).receipts;
    await writeStart(c, { helper: H2, clientId: CLIENT, clientEpoch: 4, writer: W, recordId: own.recordId, streamId: own.clients[CLIENT].streamId }, "notes/a.md");
    expect((await replyOf(lane.handle(JSON.stringify({ id: 3, method: "receiptStatus", vault: "v", want: [] })))).ok).toBe(true);
    expect(record(c.recordFile).writes["notes/a.md"].active).toBe(false);
  });
});

/**
 * Ownership that is lost one microtask after the read numbered `lossAt` (counted from `arm()`), and the
 * ownership each engine call saw when it was made. Queuing the loss at the final read is the review's
 * counterexample: when that read sits inside an awaited function, the loss lands before the caller resumes
 * and the engine is called without authority; read in the caller with no await, the call is made first.
 */
function ownership(c: Checkout) {
  const state = { exclusive: true, reads: 0, lossAt: 0, calls: [] as Array<{ method: string; exclusive: boolean }> };
  const read = () => {
    state.reads++;
    const held = state.exclusive;
    if (state.lossAt && state.reads === state.lossAt) queueMicrotask(() => { state.exclusive = false; });
    return held;
  };
  const api = c.e.receipts;
  const seen = (method: string) => state.calls.push({ method, exclusive: state.exclusive });
  const receipts: ReceiptsApi = {
    openStream: (...a) => { seen("openStream"); return api.openStream(...a); },
    apply: (...a) => { seen("apply"); return api.apply(...a); },
    status: (...a) => { seen("status"); return api.status(...a); },
    releaseGoneWriters: (...a) => { seen("releaseGoneWriters"); return api.releaseGoneWriters(...a); },
  };
  const arm = (lossAt: number) => { state.reads = 0; state.lossAt = lossAt; state.calls = []; };
  return { state, read, receipts, arm };
}

describe("F2/F3 r3: exclusive ownership is read after the final path fence returns, with no await before the engine call", () => {
  test("release: loss queued at the final ownership read cannot precede the release; the release is made with authority", async () => {
    const c = checkout();
    const o = ownership(c);
    const lane = laneFor(c, answers({ [W.pid]: "gone" }), o.read, () => false, o.receipts);
    expect((await replyOf(lane.handle(JSON.stringify(fresh)))).ok).toBe(true);
    const own = record(c.recordFile).receipts;
    await writeStart(c, { helper: H2, clientId: CLIENT, clientEpoch: 4, writer: W, recordId: own.recordId, streamId: own.clients[CLIENT].streamId }, "notes/a.md");
    // Read 1: before observing; read 2: the final check before the release.
    o.arm(2);
    const out = await replyOf(lane.handle(JSON.stringify({ id: 3, method: "receiptStatus", vault: "v", want: [] })));
    expect(o.state.reads).toBe(2);
    expect(o.state.exclusive).toBe(false);
    expect(o.state.calls).toEqual([{ method: "releaseGoneWriters", exclusive: true }, { method: "status", exclusive: false }]);
    expect(out.ok).toBe(true);
    expect(record(c.recordFile).writes["notes/a.md"].active).toBe(false);
  });

  test("openStream: loss queued at the final ownership read cannot precede activation", async () => {
    const c = checkout();
    const o = ownership(c);
    const lane = laneFor(c, answers({}), o.read, () => false, o.receipts);
    // Read 1: before attesting; read 2: the final check before openStream.
    o.arm(2);
    const out = await replyOf(lane.handle(JSON.stringify(fresh)));
    expect(o.state.reads).toBe(2);
    expect(o.state.calls).toEqual([{ method: "openStream", exclusive: true }]);
    expect(out.ok).toBe(true);
  });

  test("apply: loss queued at the final ownership read cannot precede the receipt", async () => {
    const c = checkout();
    const o = ownership(c);
    const lane = laneFor(c, answers({}), o.read, () => false, o.receipts);
    expect((await replyOf(lane.handle(JSON.stringify(fresh)))).ok).toBe(true);
    // Read 1: the final check before apply.
    o.arm(1);
    const out = await replyOf(lane.handle(JSON.stringify({ id: 2, method: "noteWriteStart", vault: "v", seq: 1, ackedThrough: 0, path: "notes/a.md", doc: DOC, gen: 1, intent: INTENT, writer: { ...W, pid: 5002 }, at: now() })));
    expect(o.state.reads).toBe(1);
    expect(o.state.calls).toEqual([{ method: "apply", exclusive: true }]);
    expect(out).toMatchObject({ ok: true, result: { ok: "write-started" } });
  });

  test("authority already lost when the final check runs refuses each writing call; guards and record unchanged, no status read", async () => {
    const c = checkout();
    const o = ownership(c);
    const lane = laneFor(c, answers({ [W.pid]: "gone" }), o.read, () => false, o.receipts);
    expect((await replyOf(lane.handle(JSON.stringify(fresh)))).ok).toBe(true);
    const own = record(c.recordFile).receipts;
    await writeStart(c, { helper: H2, clientId: CLIENT, clientEpoch: 4, writer: W, recordId: own.recordId, streamId: own.clients[CLIENT].streamId }, "notes/a.md");
    const before = fileHash(c.recordFile);
    // Loss queued at read 1 lands during the observation and path fence, before the final check.
    o.arm(1);
    const status = await replyOf(lane.handle(JSON.stringify({ id: 3, method: "receiptStatus", vault: "v", want: [] })));
    expect(status).toMatchObject({ ok: false, error: { code: "activation-refused" } });
    expect(o.state.reads).toBe(2);
    expect(o.state.calls).toEqual([]);
    const edit = await replyOf(lane.handle(JSON.stringify({ id: 4, method: "noteEdit", vault: "v", seq: 1, ackedThrough: 0, path: "notes/a.md", doc: DOC, throughGen: 1, at: now() })));
    expect(edit).toMatchObject({ ok: false, error: { code: "activation-refused" } });
    expect(o.state.calls).toEqual([]);
    expect(fileHash(c.recordFile)).toBe(before);
    expect(record(c.recordFile).writes["notes/a.md"].active).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------
// Client: a disposable peer over a real local socket.

const REC = "e".repeat(32);
const STREAM = "f".repeat(32);
const LIMITS = { window: 4, maxClients: 4, maxOwners: 64, maxDocs: 256, maxSegments: 4, maxEditRefs: 4, maxActiveWrites: 16, maxProof: 256, maxVerified: 256, maxWant: 64 };
const helloOk = `${JSON.stringify({ type: "hello", ok: true, protocol: 2, lane: "receipts", helperVersion: "0.2.0", engineLevel: 1, capabilities: ["receipts-2"] })}\n`;
const opened = (id: number) => `${JSON.stringify({ id, ok: true, result: { recordId: REC, streamId: STREAM, rebased: true, objectFormat: "sha1", base: 0, appliedThrough: 0, ackedThrough: 0, window: 4, limits: LIMITS, owners: { count: 0, items: [], omitted: 0 } } })}\n`;
const agg0 = { count: 0, oldestAt: null };
/** A well-formed empty status for `clientId` at `epoch` on the peer's stream. */
function emptyStatus(clientId = CLIENT, epoch = 4): ReceiptStatusView {
  return {
    recordId: REC, observedGeneration: 1, observedAt: 1, activation: null, captureQuarantine: null,
    stream: { clientId, streamId: STREAM, epochHighWater: epoch, sessionEpoch: epoch, base: 0, appliedThrough: 0, ackedThrough: 0, replies: 0, docs: 0, limits: LIMITS },
    vault: {
      oldestUnprotectedEdit: null, legacyVaultWide: agg0, legacyPerPath: agg0, capturedUnverified: agg0, pending: agg0, unlisted: agg0,
      activeWrites: { untagged: agg0, thisClient: agg0, otherClient: agg0, unknownOwner: agg0 }, otherClientDebt: { ...agg0, clients: 0 },
      captureQuarantine: null, resetFloor: null, counters: { resets: 0, proofEvicted: 0 },
    },
    thisClient: { unflushed: agg0, blobDebt: agg0, activeWrites: agg0, owners: { count: 0, items: [], omitted: 0 } },
    docs: { count: 0, items: [], omitted: 0 },
  };
}
const result = (id: number, value: unknown) => `${JSON.stringify({ id, ok: true, result: value })}\n`;

/** A peer that answers the hello and openStream itself and hands every other message to `answer`. */
async function peer(answer: (socket: Socket, message: Record<string, unknown>) => void) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "s")));
  const path = join(dir, "h");
  const sockets = new Set<Socket>();
  const received: Array<Record<string, unknown>> = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString();
      for (let end = data.indexOf("\n"); end >= 0; end = data.indexOf("\n")) {
        const m = JSON.parse(data.slice(0, end)) as Record<string, unknown>;
        data = data.slice(end + 1);
        received.push(m);
        if (m.type === "hello") socket.write(helloOk);
        else if (m.method === "openStream") socket.write(opened(m.id as number));
        else answer(socket, m);
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
  return { path, received };
}
async function connected(path: string, timeoutMs = 500) {
  const options = { client: "boundaries", clientId: CLIENT, clientEpoch: 4, writer: { ...W }, timeoutMs };
  const c = await connectReceipts(path, options);
  cleanups.push(() => c.close());
  return { c, options };
}
const failure = (p: Promise<unknown>) => p.then(() => "resolved", (e: unknown) => (e instanceof ReceiptsClientError ? `${e.code}:${e.sent}` : `other:${String(e)}`));
const editBody = (seq: number) => ({ method: "noteEdit" as const, vault: "v", seq, ackedThrough: 0, path: "notes/a.md", doc: { ...DOC }, throughGen: 1, at: now() });
const applied = (seq: number, epoch = 4) => ({ seq, recordId: REC, durable: true, epoch, ok: "edit", ticket: 1, retiredRefs: [] });

describe("F4: replies are checked against the identities sent, not the caller's objects", () => {
  test("send: the wire carries seq 1 after the caller changes its object to 2; a reply for 2 is refused, a reply for 1 accepted", async () => {
    const wrong = await peer((s, m) => s.write(result(m.id as number, applied(2))));
    const w = await connected(wrong.path);
    await w.c.openStream(fresh);
    const request = editBody(1);
    const sent = failure(w.c.send(request));
    request.seq = 2;
    expect(await sent).toBe("outcome-unknown:true");
    expect(wrong.received.find((m) => m.method === "noteEdit")).toMatchObject({ seq: 1, vault: "v" });

    const right = await peer((s, m) => s.write(result(m.id as number, applied(1))));
    const r = await connected(right.path);
    await r.c.openStream(fresh);
    const again = editBody(1);
    const accepted = r.c.send(again);
    again.seq = 2;
    again.vault = "x";
    expect(await accepted).toEqual({ ok: true, result: applied(1) as never });
  });

  test("connection identity: changing the options after connecting changes neither the epoch nor the client checked", async () => {
    const epoch99 = await peer((s, m) => s.write(result(m.id as number, applied(m.seq as number, 99))));
    const a = await connected(epoch99.path);
    await a.c.openStream(fresh);
    a.options.clientEpoch = 99;
    expect(await failure(a.c.send(editBody(1)))).toBe("outcome-unknown:true");

    const epoch4 = await peer((s, m) => s.write(result(m.id as number, applied(m.seq as number, 4))));
    const b = await connected(epoch4.path);
    await b.c.openStream(fresh);
    b.options.clientEpoch = 99;
    expect((await b.c.send(editBody(1))).ok).toBe(true);

    const original = await peer((s, m) => s.write(result(m.id as number, emptyStatus(CLIENT))));
    const c = await connected(original.path);
    c.options.clientId = "d".repeat(32);
    expect((await c.c.status("v", [])).ok).toBe(true);
    const changed = await peer((s, m) => s.write(result(m.id as number, emptyStatus("d".repeat(32)))));
    const d = await connected(changed.path);
    d.options.clientId = "d".repeat(32);
    expect(await failure(d.c.status("v", []))).toBe("bad-reply:true");
  });

  test("request options are taken when the call is made: a later change to its timeout does not extend it", async () => {
    const silent = await peer(() => undefined);
    const { c } = await connected(silent.path, 5_000);
    const opts = { timeoutMs: 50 };
    const begun = Date.now();
    const pending = failure(c.status("v", [], opts));
    opts.timeoutMs = 5_000;
    expect(await pending).toBe("timeout:true");
    expect(Date.now() - begun).toBeLessThan(1_000);
  });
});

describe("F5: status replies must fit this session, the engine's state precedence and one object format", () => {
  const want = [{ path: "notes/a.md", doc: DOC }];
  const stream: { recordId: string; streamId: string; objectFormat: "sha1" | "sha256" } = { recordId: REC, streamId: STREAM, objectFormat: "sha1" };
  const at4 = { clientId: CLIENT, clientEpoch: 4, stream };
  const code = (x: unknown, expected = at4) => {
    try {
      checkReceiptStatusView(structuredClone(x), want, expected);
      return "accepted";
    } catch (error) {
      return error instanceof LaneError ? error.code : `threw ${String(error)}`;
    }
  };
  const row = (over: Record<string, unknown>) => {
    const v = emptyStatus() as unknown as Record<string, any>;
    v.docs = { count: 1, items: [{ path: "notes/a.md", doc: DOC, state: "none", unflushedThroughGen: null, flushed: null, proof: null, verified: null, activeWrite: false, ...over }], omitted: 0 };
    return v;
  };
  const sha1 = (c: string) => c.repeat(40);
  const sha256 = (c: string) => c.repeat(64);
  const verified = { gen: 1, blobOid: sha1("1"), snapshot: sha1("2"), snapshotSeq: 1, at: 5 };

  test("an actual engine status is accepted; another session epoch, a high-water mark below the opened epoch or an owner above it is refused", async () => {
    const c = checkout();
    const session = await activate(c);
    const real = receiptStatusView(record(c.recordFile), session, want, 64, Date.now());
    expect(code(real, { clientId: CLIENT, clientEpoch: 4, stream: { recordId: session.recordId!, streamId: session.streamId!, objectFormat: "sha1" } })).toBe("accepted");
    // One requested row, accounted for, so each refusal below is the epoch's alone.
    const base = row({}) as unknown as ReceiptStatusView;
    expect(code(base)).toBe("accepted");
    expect(code({ ...base, stream: { ...base.stream, sessionEpoch: 99, epochHighWater: 1 } })).toBe("bad-request");
    expect(code({ ...base, stream: { ...base.stream, sessionEpoch: 3 } })).toBe("bad-request");
    expect(code({ ...base, stream: { ...base.stream, epochHighWater: 3 } })).toBe("bad-request");
    // Before this connection opened the stream, an older process's high-water mark is legitimate; a newer one's always is.
    expect(code({ ...base, stream: { ...base.stream, epochHighWater: 3 } }, { ...at4, stream: null as never })).toBe("accepted");
    expect(code({ ...base, stream: { ...base.stream, epochHighWater: 7 } })).toBe("accepted");
    const owners = { count: 1, items: [{ owner: DOC.owner, epoch: 5, unflushed: agg0, blobDebt: agg0, activeWrites: 0 }], omitted: 0 };
    expect(code({ ...base, thisClient: { ...base.thisClient, owners } })).toBe("bad-request");
  });

  test("the row state is the engine's precedence: verified beside unflushed debt is refused; older verified or proof rows beside newer debt are kept", () => {
    expect(code(row({ state: "verified", unflushedThroughGen: 7, verified }))).toBe("bad-request");
    expect(code(row({ state: "debt", unflushedThroughGen: 7, verified }))).toBe("accepted");
    expect(code(row({ state: "debt", unflushedThroughGen: 7, proof: { gen: 2, blobOid: sha1("3"), state: "captured", snapshotSeq: 2 }, verified }))).toBe("accepted");
    expect(code(row({ state: "verified", flushed: { gen: 2, blobOid: sha1("4"), ackGen: 2 }, verified }))).toBe("bad-request");
    expect(code(row({ state: "debt", flushed: { gen: 2, blobOid: sha1("4"), ackGen: 2 }, verified }))).toBe("accepted");
    expect(code(row({ state: "registered", flushed: { gen: 2, blobOid: sha1("4"), ackGen: 2 }, proof: { gen: 2, blobOid: sha1("4"), state: "registered", snapshotSeq: null }, verified }))).toBe("accepted");
    expect(code(row({ state: "verified", proof: { gen: 2, blobOid: sha1("4"), state: "registered", snapshotSeq: null }, verified }))).toBe("bad-request");
    expect(code(row({ state: "verified", verified }))).toBe("accepted");
    expect(code(row({ state: "none" }))).toBe("accepted");
    expect(code(row({ state: "debt" }))).toBe("bad-request");
    expect(code(row({ state: "none", verified }))).toBe("bad-request");
    const truncated = row({});
    truncated.docs = { count: 1, items: [], omitted: 1 };
    expect(code(truncated)).toBe("accepted");
  });

  test("object ids have the opened stream's length; before an openStream, one length throughout", () => {
    const mixed = row({ state: "verified", verified: { ...verified, snapshot: sha256("2") } });
    expect(code(mixed)).toBe("bad-request");
    expect(code(mixed, { ...at4, stream: null as never })).toBe("bad-request");
    const all256 = row({ state: "verified", verified: { ...verified, blobOid: sha256("1"), snapshot: sha256("2") } });
    expect(code(all256)).toBe("bad-request");
    expect(code(all256, { ...at4, stream: { ...stream, objectFormat: "sha256" } })).toBe("accepted");
    expect(code(all256, { ...at4, stream: null as never })).toBe("accepted");
    const flushed256 = row({ state: "debt", flushed: { gen: 2, blobOid: sha256("4"), ackGen: 2 }, verified });
    expect(code(flushed256)).toBe("bad-request");
  });
});

describe("F6: each call's deadline and cancellation count from the call, waiting included", () => {
  test("a queued call cancelled while an earlier one is held settles unsent at once; the earlier one still completes", async () => {
    const held: Array<() => void> = [];
    const p = await peer((s, m) => held.push(() => s.write(result(m.id as number, emptyStatus()))));
    const { c } = await connected(p.path, 5_000);
    const first = c.status("v", [], { timeoutMs: 300 });
    while (held.length === 0) await pause(5);
    const abort = new AbortController();
    const begun = Date.now();
    const queued = failure(c.status("v", [], { timeoutMs: 10, signal: abort.signal }));
    abort.abort();
    expect(await queued).toBe("not-sent:false");
    expect(Date.now() - begun).toBeLessThan(60);
    held[0]!();
    expect((await first).ok).toBe(true);
    expect(p.received.filter((m) => m.method === "receiptStatus")).toHaveLength(1);
    const last = c.status("v", []);
    while (held.length < 2) await pause(5);
    held[1]!();
    expect((await last).ok).toBe(true);
  });

  test("a queued call whose deadline passes is unsent and never written; the wait counts toward the deadline after it is sent", async () => {
    const held: Array<() => void> = [];
    const p = await peer((s, m) => held.push(() => s.write(result(m.id as number, emptyStatus()))));
    const { c } = await connected(p.path, 5_000);
    const first = c.status("v", [], { timeoutMs: 2_000 });
    first.catch(() => undefined);
    while (held.length === 0) await pause(5);
    const expiring = Date.now();
    expect(await failure(c.status("v", [], { timeoutMs: 30 }))).toBe("not-sent:false");
    expect(Date.now() - expiring).toBeLessThan(150);
    // Queued with 250 ms behind a call answered after about 150 ms: it is sent, then times out at about 250 ms in all.
    const begun = Date.now();
    const second = failure(c.status("v", [], { timeoutMs: 250 }));
    await pause(150);
    held[0]!();
    expect((await first).ok).toBe(true);
    expect(await second).toBe("timeout:true");
    const elapsed = Date.now() - begun;
    expect(elapsed).toBeGreaterThanOrEqual(240);
    expect(elapsed).toBeLessThan(380);
    expect(p.received.filter((m) => m.method === "receiptStatus")).toHaveLength(2);
    expect(await failure(c.status("v", []))).toBe("not-sent:false");
  });

  test("cancelling a sent receipt leaves its outcome unknown and closes; queued calls are unsent; every listener is removed once", async () => {
    const p = await peer(() => undefined);
    const { c } = await connected(p.path, 5_000);
    await c.openStream(fresh);
    const counts = { added: 0, removed: 0 };
    const tracked = () => {
      const signal = new AbortController().signal;
      const add = signal.addEventListener.bind(signal);
      const remove = signal.removeEventListener.bind(signal);
      signal.addEventListener = ((...args: Parameters<typeof add>) => { counts.added++; add(...args); }) as typeof add;
      signal.removeEventListener = ((...args: Parameters<typeof remove>) => { counts.removed++; remove(...args); }) as typeof remove;
      return signal;
    };
    const abort = new AbortController();
    const sent = failure(c.send(editBody(1), { signal: abort.signal }));
    const queued = [failure(c.send(editBody(2), { signal: tracked() })), failure(c.status("v", [], { signal: tracked() }))];
    await pause(20);
    abort.abort();
    expect(await sent).toBe("outcome-unknown:true");
    expect(await Promise.all(queued)).toEqual(["not-sent:false", "not-sent:false"]);
    expect(counts).toEqual({ added: 2, removed: 2 });
    expect(p.received.filter((m) => m.method === "noteEdit")).toHaveLength(1);
    expect(await failure(c.send(editBody(3)))).toBe("not-sent:false");
  });
});
