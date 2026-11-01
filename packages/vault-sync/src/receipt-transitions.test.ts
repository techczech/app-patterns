import { describe, expect, test } from "bun:test";
import { applyCapture, applyPushed, applyVerified, convertedRecord, emptyRecord, noteFlush as legacyFlush, noteWriteStart as legacyStart, parseRecord, parseRecordDetailed, repairedLedgerRecord, type CaptureOutcome, type DeadlineRecord } from "./deadline.ts";
import { MAX_DOCS, MAX_PROOF, ledgerOf, recordSafety, stampBroken, type DocRef, type ReceiptLedger, type ReceiptResult, type WriterIncarnation } from "./receipt-ledger.ts";
import { receiptStatusView, type ReceiptStatusView } from "./receipt-status.ts";
import { applyReceipt, checkSeqRequest, isReceiptError, openStream, releaseGoneWriters, type ReceiptError, type ReceiptSession, type SeqRequest } from "./receipt-transitions.ts";

/**
 * Editor receipt transitions (plan-editor-receipts-protocol-v2 §6-§12, E1). Every persisted record is
 * written to JSON and strictly parsed back, as the engine does across a restart.
 */

const NOW = 1_800_000_000_000;
const HELPER = { host: "host-a", pid: 100, startedAt: 1000, helperVersion: "0.2.0" };
const HELPER2 = { host: "host-a", pid: 101, startedAt: 2000, helperVersion: "0.2.0" };
const C1 = "c".repeat(32);
const C2 = "d".repeat(32);
const O1 = "1".repeat(32);
const O2 = "2".repeat(32);
const O3 = "3".repeat(32);
const I1 = "e".repeat(32);
const I2 = "f".repeat(32);
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const writerOf = (clientEpoch: number, pid = 200 + clientEpoch): WriterIncarnation => ({ host: "host-a", pid, startedAt: 5000 + clientEpoch, clientEpoch });
const docOf = (owner: string, ownerEpoch = 1, docEpoch = 1): DocRef => ({ owner, ownerEpoch, docEpoch });
const attest = (helper = HELPER, prior: null | { by: typeof HELPER; quiescence: "gone" | "handover" } = null) => ({ helper, exclusive: true as const, prior });

function roundtrip(record: DeadlineRecord): DeadlineRecord {
  const parsed = parseRecord(JSON.parse(JSON.stringify(record)));
  expect(parsed).not.toBeNull();
  return parsed!;
}

interface Client { session: ReceiptSession; record: DeadlineRecord; now: number; seq: number; acked: number }

function client(record: DeadlineRecord, epoch = 1, clientId = C1, helper = HELPER, nextSeq = 1, ackedThrough = 0, known: { recordId: string | null; streamId: string | null } = { recordId: null, streamId: null }): Client {
  const session: ReceiptSession = { helper, clientId, clientEpoch: epoch, writer: writerOf(epoch), recordId: null, streamId: null };
  const out = openStream(record, session, attest(helper), { id: 0, method: "openStream", vault: "v", knownRecordId: known.recordId, knownStreamId: known.streamId, nextSeq, ackedThrough }, NOW, "sha1");
  if (isReceiptError(out.reply)) throw new Error(`openStream: ${out.reply.error}`);
  return { session: { ...session, recordId: out.reply.recordId, streamId: out.reply.streamId }, record: roundtrip(out.record), now: NOW, seq: out.reply.appliedThrough + 1, acked: out.reply.ackedThrough };
}

type Body = { [K in SeqRequest["method"]]: Omit<Extract<SeqRequest, { method: K }>, "id" | "vault" | "seq" | "ackedThrough"> }[SeqRequest["method"]];

function send(c: Client, body: Body, opts: { seq?: number; ackedThrough?: number } = {}) {
  const req = { id: 7, vault: "v", seq: opts.seq ?? c.seq, ackedThrough: opts.ackedThrough ?? c.acked, ...body } as SeqRequest;
  expect(checkSeqRequest(req, "sha1")).toBe(true);
  const before = c.record;
  const out = applyReceipt(c.record, c.session, req, c.now);
  if (isReceiptError(out.reply)) expect(out.record).toBe(before); // nothing to persist
  if (out.persistKind !== "none") c.record = roundtrip(out.record);
  if (!isReceiptError(out.reply)) {
    if (req.seq === c.seq) c.seq += 1;
    c.acked = Math.max(c.acked, req.seq);
  }
  return out;
}

const edit = (throughGen: number, at: number, doc = docOf(O1), path = "a.md"): Body => ({ method: "noteEdit", path, doc, throughGen, at });
const flush = (gen: number, editRef: number, blobOid: string, doc = docOf(O1), path = "a.md", writeRef: number | null = null, intent = I1): Body => ({ method: "noteFlush", path, doc, gen, intent, editRef, writeRef, blobOid });
const start = (gen: number, writer: WriterIncarnation, at: number, doc = docOf(O1), path = "a.md", intent = I1): Body => ({ method: "noteWriteStart", path, doc, gen, intent, writer, at });

const ok = (reply: ReceiptResult | ReceiptError) => {
  if (isReceiptError(reply) || "refused" in reply) throw new Error(`expected an applied result, got ${JSON.stringify(reply)}`);
  return reply;
};
const ledger = (c: Client): ReceiptLedger => ledgerOf(c.record)!;
const stream = (c: Client, clientId = C1) => ledger(c).clients[clientId]!;
const docRow = (c: Client, doc = docOf(O1), path = "a.md") => stream(c).docs.find((d) => d.path === path && d.doc.owner === doc.owner && d.doc.docEpoch === doc.docEpoch);

const outcome = (r: DeadlineRecord, startedAt: number, extra: Partial<CaptureOutcome> = {}): CaptureOutcome => ({
  snapshot: "1".repeat(40), ref: "r", startedAt, startGen: r.generation, pendingFloor: startedAt, committed: true, sawChange: false,
  readPaths: [], goneConfirmed: [], pendingPaths: [], clearedPaths: [], unlistedFolders: [], relistedFolders: [], ...extra,
});
const capture = (c: Client, startedAt: number, extra: Partial<CaptureOutcome>) => { c.record = roundtrip(applyCapture(c.record, outcome(c.record, startedAt, extra)).record); };
const verify = (c: Client, snapshot: string, at: number) => {
  const pushed = applyPushed(c.record, snapshot, "r");
  c.record = roundtrip(applyVerified(pushed, pushed.lastPushed!, at));
};
const view = (c: Client, want: { path: string; doc: DocRef }[], maxItems = 64) => receiptStatusView(c.record, c.session, want, maxItems, c.now) as ReceiptStatusView;

describe("activation (CX-S2b, I11)", () => {
  test("needs an attestation; a second helper needs a matching prior; requests re-check the helper", () => {
    const empty = emptyRecord();
    const session: ReceiptSession = { helper: HELPER, clientId: C1, clientEpoch: 1, writer: writerOf(1), recordId: null, streamId: null };
    const req = { id: 0, method: "openStream" as const, vault: "v", knownRecordId: null, knownStreamId: null, nextSeq: 1, ackedThrough: 0 };
    for (const bad of [undefined, { helper: HELPER, exclusive: false, prior: null }, attest(HELPER2)]) {
      const out = openStream(empty, session, bad, req, NOW, "sha1");
      expect((out.reply as ReceiptError).error).toBe("activation-refused");
      expect(out.record).toBe(empty);
    }
    const c = client(empty);
    expect(ledger(c).activation).toEqual({ level: 1, by: HELPER, at: NOW, handovers: 0 });
    // Another helper incarnation without the matching prior, or claiming a prior that is not the holder.
    const s2 = { ...session, helper: HELPER2 };
    for (const prior of [null, { by: HELPER2, quiescence: "gone" as const }]) {
      const out = openStream(c.record, s2, attest(HELPER2, prior), req, NOW, "sha1");
      expect((out.reply as ReceiptError).error).toBe("activation-refused");
    }
    // Handover from the exact holder: the old helper can no longer apply receipts.
    const known = { knownRecordId: c.session.recordId, knownStreamId: c.session.streamId };
    const handed = openStream(c.record, s2, attest(HELPER2, { by: HELPER, quiescence: "handover" }), { ...req, ...known }, NOW, "sha1");
    expect(isReceiptError(handed.reply)).toBe(false);
    const after = roundtrip(handed.record);
    expect(ledgerOf(after)!.activation).toMatchObject({ by: HELPER2, handovers: 1 });
    c.record = after;
    expect((send(c, edit(1, NOW - 10)).reply as ReceiptError).error).toBe("activation-refused");
  });
});

describe("stream negotiation (R3)", () => {
  test("an absent stream starts at nextSeq - 1 for base, applied and acknowledged; eviction then nextSeq 21 works", () => {
    let c = client(emptyRecord(), 1, C1, HELPER, 21, 20);
    expect(stream(c)).toMatchObject({ base: 20, appliedThrough: 20, ackedThrough: 20 });
    expect(c.seq).toBe(21);
    ok(send(c, edit(1, NOW - 10)).reply);
    ok(send(c, flush(1, 21, A)).reply);
    // Settle that doc so the client holds nothing, then fill the table with three other idle clients.
    capture(c, NOW, { readPaths: ["a.md"], readOids: { "a.md": A } });
    ok(send(c, edit(2, NOW - 5)).reply);
    ok(send(c, flush(2, 23, B)).reply);
    capture(c, NOW + 1, { readPaths: ["a.md"], readOids: { "a.md": B } });
    const idle = stream(c);
    expect(idle.docs).toEqual([]);
    expect(idle.appliedThrough).toBe(24);
    // The client acknowledges its last seq by reopening the retained stream.
    const reopened = client(c.record, 1, C1, HELPER, 25, 24, { recordId: c.session.recordId, streamId: c.session.streamId });
    expect(stream(reopened)).toMatchObject({ appliedThrough: 24, ackedThrough: 24 });
    let record = reopened.record;
    for (const [i, id] of ["4".repeat(32), "5".repeat(32), "6".repeat(32), "7".repeat(32)].entries()) {
      const other = client(record, 1, id, HELPER);
      record = { ...other.record };
      if (i === 3) {
        // The fifth client evicted the least recently seen idle one, C1 (all were seen at NOW; insertion order breaks the tie).
        expect(Object.keys(ledgerOf(record)!.clients)).not.toContain(C1);
      }
    }
    // C1 returns with its old identities and nextSeq 25: a new stream at 24, reported as rebased.
    const session: ReceiptSession = { helper: HELPER, clientId: C1, clientEpoch: 1, writer: writerOf(1), recordId: null, streamId: null };
    const back = openStream(record, session, attest(), { id: 0, method: "openStream", vault: "v", knownRecordId: c.session.recordId, knownStreamId: c.session.streamId, nextSeq: 25, ackedThrough: 24 }, NOW, "sha1");
    const reply = back.reply as Exclude<typeof back.reply, ReceiptError>;
    expect(reply.rebased).toBe(true);
    expect(reply.streamId).not.toBe(c.session.streamId);
    expect([reply.base, reply.appliedThrough, reply.ackedThrough]).toEqual([24, 24, 24]);
    c = { session: { ...session, recordId: reply.recordId, streamId: reply.streamId }, record: roundtrip(back.record), now: NOW, seq: 25, acked: 24 };
    ok(send(c, edit(3, NOW - 1)).reply);
  });

  test("a lost openStream reply: a retry with stale identities gets the retained stream's, and rejoins it without reset", () => {
    const c = client(emptyRecord());
    ok(send(c, edit(1, NOW - 10)).reply);
    const session = { ...c.session, recordId: null, streamId: null };
    const req = { id: 0, method: "openStream" as const, vault: "v", knownRecordId: null, knownStreamId: null, nextSeq: 1, ackedThrough: 0 };
    const stale = openStream(c.record, session, attest(), req, NOW, "sha1");
    const err = stale.reply as ReceiptError;
    expect(err.error).toBe("stream-required");
    expect(err.stream).toEqual({ recordId: c.session.recordId!, streamId: c.session.streamId!, base: 0, appliedThrough: 1, ackedThrough: 0 });
    expect(stale.record).toBe(c.record);
    const rejoin = openStream(c.record, session, attest(), { ...req, knownRecordId: err.stream!.recordId, knownStreamId: err.stream!.streamId, nextSeq: 2, ackedThrough: 1 }, NOW, "sha1");
    const reply = rejoin.reply as Exclude<typeof rejoin.reply, ReceiptError>;
    expect(reply.rebased).toBe(false);
    expect(reply.streamId).toBe(c.session.streamId!);
    expect(ledgerOf(rejoin.record)!.clients[C1]!.docs[0]!.segments).toHaveLength(1);
  });
});

describe("deduplication and sequence order (T2, I2-I4, S8)", () => {
  test("identical replay returns the stored reply; other bodies, gaps, retired seqs and early acks change nothing", () => {
    const c = client(emptyRecord());
    const first = ok(send(c, edit(1, NOW - 10)).reply);
    expect(first).toMatchObject({ seq: 1, ok: "edit", ticket: 1, durable: true, epoch: 1 });
    // Identical replay, nothing acknowledged: cached, nothing to write (the engine still runs the barrier).
    const replay = send(c, edit(1, NOW - 10), { seq: 1, ackedThrough: 0 });
    expect(replay.reply).toEqual(first);
    expect(replay.persistKind).toBe("none");
    // The same seq with another body.
    expect((send(c, edit(2, NOW - 10), { seq: 1, ackedThrough: 0 }).reply as ReceiptError).error).toBe("conflict");
    expect((send(c, edit(2, NOW - 10), { seq: 3, ackedThrough: 0 }).reply as ReceiptError).error).toBe("out-of-order");
    expect((send(c, edit(2, NOW - 10), { seq: 2, ackedThrough: 2 }).reply as ReceiptError).error).toBe("ack-ahead");
    // A replay of seq 2 that acknowledges seq 1: cached result plus the acknowledgement advance only.
    const second = ok(send(c, edit(2, NOW - 9), { seq: 2, ackedThrough: 0 }).reply);
    const acking = send(c, edit(2, NOW - 9), { seq: 2, ackedThrough: 1 });
    expect(acking.reply).toEqual(second);
    expect(acking.persistKind).toBe("ack-only");
    expect(stream(c).ackedThrough).toBe(1);
    expect(stream(c).replies.map((r) => r.seq)).toEqual([2]);
    expect((send(c, edit(1, NOW - 10), { seq: 1, ackedThrough: 1 }).reply as ReceiptError).error).toBe("retired");
    // A delayed duplicate with a lower acknowledgement does not lower the watermark (CX-S8c).
    expect(send(c, edit(2, NOW - 9), { seq: 2, ackedThrough: 0 }).reply).toEqual(second);
    expect(stream(c).ackedThrough).toBe(1);
    expect(c.record.generation).toBe(2);
  });

  test("the window holds four unacknowledged replies", () => {
    const c = client(emptyRecord());
    for (let g = 1; g <= 4; g++) ok(send(c, edit(g, NOW - 10), { ackedThrough: 0 }).reply);
    expect((send(c, edit(5, NOW - 10), { ackedThrough: 0 }).reply as ReceiptError).error).toBe("window-full");
    ok(send(c, edit(5, NOW - 10), { ackedThrough: 1 }).reply);
    expect(stream(c).replies.map((r) => r.seq)).toEqual([2, 3, 4, 5]);
  });

  test("each no-seq error leaves the seq free for a different body (CX-S8f)", () => {
    const c = client(emptyRecord());
    expect((send(c, edit(1, NOW + 2 * 86_400_000)).reply as ReceiptError).error).toBe("clock-ahead");
    expect((send(c, edit(1, NOW - 10), { ackedThrough: 5 }).reply as ReceiptError).error).toBe("ack-ahead");
    const accepted = ok(send(c, edit(7, NOW - 20)).reply);
    expect(accepted.seq).toBe(1);
    expect(docRow(c)!.segments).toEqual([{ throughGen: 7, at: NOW - 20, ticket: 1 }]);
  });

  test("a lost reply replayed after the clock went back 48 hours returns the cached success (CX-S8a)", () => {
    const c = client(emptyRecord());
    const first = ok(send(c, edit(1, NOW - 10)).reply);
    c.now = NOW - 48 * 3_600_000;
    expect(send(c, edit(1, NOW - 10), { seq: 1, ackedThrough: 0 }).reply).toEqual(first);
    // A genuinely new seq at that clock is clock-ahead; within a day ahead it is stored at the engine's time.
    expect((send(c, edit(2, NOW - 10)).reply as ReceiptError).error).toBe("clock-ahead");
    c.now = NOW - 3_600_000;
    ok(send(c, edit(2, NOW - 10)).reply);
    expect(docRow(c)!.segments.find((s) => s.throughGen === 2)!.at).toBe(NOW - 3_600_000);
  });

  test("semantic refusals are cached and replay identically (I4)", () => {
    const c = client(emptyRecord());
    ok(send(c, edit(4, NOW - 40)).reply);
    ok(send(c, edit(5, NOW - 30)).reply);
    const refused = send(c, flush(4, 2, A)).reply;
    expect(refused).toMatchObject({ seq: 3, refused: "gen-mismatch" });
    expect(send(c, flush(4, 2, A), { seq: 3, ackedThrough: 2 }).reply).toEqual(refused);
  });
});

describe("references and debt (S4, S6, I5, I6)", () => {
  test("a flush with a newer edit's reference is gen-mismatch; the exact reference covers only gens up to its own (CX-S4a/b)", () => {
    const c = client(emptyRecord());
    ok(send(c, edit(4, NOW - 40)).reply);
    ok(send(c, edit(5, NOW - 30)).reply);
    expect(send(c, flush(4, 2, A)).reply).toMatchObject({ refused: "gen-mismatch" });
    expect(docRow(c)!.segments.map((s) => s.throughGen)).toEqual([4, 5]);
    const flushed = ok(send(c, flush(4, 1, A)).reply);
    expect(flushed).toMatchObject({ ok: "flushed", endedWrite: false });
    expect(docRow(c)!.segments).toEqual([{ throughGen: 5, at: NOW - 30, ticket: 2 }]);
    expect(docRow(c)!.flushed).toMatchObject({ gen: 4, blobOid: A, from: NOW - 40 });
    expect(docRow(c)!.editRefs.map((r) => r.seq)).toEqual([2]);
  });

  test("four edit replies acknowledged, then four flushes without new edits all apply (CX-S6a)", () => {
    const c = client(emptyRecord());
    const paths = ["p1.md", "p2.md", "p3.md", "p4.md"];
    for (const p of paths) ok(send(c, edit(1, NOW - 10, docOf(O1), p), { ackedThrough: 0 }).reply);
    expect(stream(c).replies).toHaveLength(4);
    // The client acknowledges seq 4 with the first flush; the edit replies retire, their references stay live.
    for (const [i, p] of paths.entries()) ok(send(c, flush(1, i + 1, A, docOf(O1), p), { ackedThrough: 4 }).reply);
    expect(stream(c).ackedThrough).toBe(4);
    expect(stream(c).docs.every((d) => d.segments.length === 0 && d.flushed !== null)).toBe(true);
  });

  test("old saved gen 1 below four newer coalesced segments: its reissued reference survives and flushes with a finite conservative age (T5, CX-S6c)", () => {
    const c = client(emptyRecord());
    const ats = [NOW - 50, NOW - 40, NOW - 30, NOW - 20, NOW - 10];
    for (let g = 1; g <= 5; g++) ok(send(c, edit(g, ats[g - 1]!)).reply);
    expect(docRow(c)!.segments.map((s) => [s.throughGen, s.at])).toEqual([[2, NOW - 50], [3, NOW - 30], [4, NOW - 20], [5, NOW - 10]]);
    expect(docRow(c)!.editRefs.map((r) => r.seq)).toEqual([2, 3, 4, 5]);
    // Reissue the saved generation: an existing reference (smallest seq) is retired, the new one survives.
    const reissued = ok(send(c, edit(1, NOW - 5)).reply) as Extract<ReceiptResult, { ok: "edit" }>;
    expect(reissued.retiredRefs).toEqual([2]);
    expect(docRow(c)!.editRefs.map((r) => r.seq)).toEqual([3, 4, 5, 6]);
    expect(docRow(c)!.segments.map((s) => s.throughGen)).toEqual([2, 3, 4, 5]);
    // Priority flush of the saved bytes: no segment is covered, so the earliest remaining age is used.
    const flushed = ok(send(c, flush(1, 6, A)).reply);
    expect(flushed.ok).toBe("flushed");
    const row = docRow(c)!;
    expect(row.flushed).toEqual({ gen: 1, blobOid: A, from: NOW - 50, ackGen: c.record.generation, seq: 7 });
    expect(Number.isFinite(row.flushed!.from)).toBe(true);
    // Newer debt stays owed with its own ages; the strict parser accepted every step (roundtrip).
    expect(row.segments.map((s) => [s.throughGen, s.at])).toEqual([[2, NOW - 50], [3, NOW - 30], [4, NOW - 20], [5, NOW - 10]]);
    expect(row.editRefs.map((r) => r.seq)).toEqual([3, 4, 5]);
    expect(c.record.oldestUnprotectedEdit).toBe(NOW - 50);
  });

  test("a reference with no finite covered, write, blob or remaining age is refused before any document change (T5)", () => {
    const c = client(emptyRecord());
    ok(send(c, edit(3, NOW - 10)).reply);
    const raw = JSON.parse(JSON.stringify(c.record));
    raw.receipts.clients[C1].docs[0].segments = [];
    c.record = roundtrip(raw);
    const before = JSON.stringify(docRow(c));
    expect(send(c, flush(3, 1, A)).reply).toMatchObject({ refused: "ref-invalid" });
    expect(JSON.stringify(docRow(c))).toBe(before);
  });

  test("the 257th document is pressure without a seq; flushes for existing documents still apply (CX-S6b)", () => {
    const c = client(emptyRecord());
    for (let i = 0; i < MAX_DOCS; i++) ok(send(c, edit(1, NOW - 10, docOf(O1), `d/${i}.md`)).reply);
    const seq = c.seq;
    expect((send(c, edit(1, NOW - 10, docOf(O1), "d/new.md")).reply as ReceiptError).error).toBe("pressure");
    expect(c.seq).toBe(seq);
    expect(ok(send(c, flush(1, 1, A, docOf(O1), "d/0.md")).reply).seq).toBe(seq);
  });
});

describe("writes (S3, I9, I10)", () => {
  test("a second writer on an active path is write-active; no epoch, time, legacy flush or reset ends the mark (CX-S3a/b)", () => {
    let c4 = client(emptyRecord(), 4);
    ok(send(c4, edit(1, NOW - 100, docOf(O1, 4))).reply);
    const started = ok(send(c4, start(1, writerOf(4), NOW - 90, docOf(O1, 4))).reply) as Extract<ReceiptResult, { ok: "write-started" }>;
    const mark = () => c4.record.writes["a.md"]!;
    expect(mark()).toMatchObject({ active: true, since: NOW - 90, gen: started.token });
    // Epoch 5 opens the same stream and starts a write on the same path.
    const c5 = client(c4.record, 5, C1, HELPER, c4.seq, c4.acked, { recordId: c4.session.recordId, streamId: c4.session.streamId });
    ok(send(c5, edit(1, NOW - 10, docOf(O2, 5))).reply);
    expect(send(c5, start(1, writerOf(5), NOW - 5, docOf(O2, 5), "a.md", I2)).reply).toMatchObject({ refused: "write-active" });
    expect(c5.record.writes["a.md"]).toMatchObject({ active: true, since: NOW - 90 });
    // A legacy acknowledgement naming the exact token cannot end a tagged mark.
    const legacy = legacyFlush(c5.record, { upTo: 0, paths: ["a.md"], completedWrites: [{ path: "a.md", token: started.token }] }, NOW);
    expect(legacy.writes["a.md"]).toMatchObject({ active: true, since: NOW - 90 });
    // A damaged-ledger reset keeps it active (tag strictly valid, kept).
    const reset = repairedLedgerRecord(c5.record, {}, NOW, NOW);
    expect(reset.writes["a.md"]).toMatchObject({ active: true, since: NOW - 90, owner: { clientId: C1, seq: 2 } });
    // The epoch-4 session is fenced from new requests.
    c4 = { ...c4, record: c5.record };
    expect((send(c4, edit(2, NOW - 10, docOf(O1, 4))).reply as ReceiptError).error).toBe("superseded");
  });

  test("gone-writer release needs the exact writer, mark generation and host (CX-S3c)", () => {
    const c = client(emptyRecord(), 4);
    ok(send(c, edit(1, NOW - 100, docOf(O1, 4))).reply);
    const { token } = ok(send(c, start(1, writerOf(4), NOW - 90, docOf(O1, 4))).reply) as Extract<ReceiptResult, { ok: "write-started" }>;
    const proof = { path: "a.md", writer: writerOf(4), markGen: token, checkedAt: NOW };
    for (const [p, host] of [[{ ...proof, writer: { ...writerOf(4), startedAt: 1 } }, "host-a"], [{ ...proof, markGen: token + 1 }, "host-a"], [proof, "host-b"]] as const) {
      const out = releaseGoneWriters(c.record, [p], host);
      expect(out.released).toEqual([]);
      expect(out.record).toBe(c.record);
    }
    const out = releaseGoneWriters(c.record, [proof], "host-a");
    expect(out.released).toEqual(["a.md"]);
    const r = roundtrip(out.record);
    expect(r.writes["a.md"]).toEqual({ gen: token + 1, active: false, since: NOW - 90 });
    expect(r.pendingSince["a.md"]).toBe(NOW - 90);
    expect(ledgerOf(r)!.clients[C1]!.docs[0]!.write).toBeNull();
  });

  test("an unknown-owner orphan from conversion stays guarded: write-active for a new client, never released (CX-S3d)", () => {
    const old = { ...emptyRecord(), generation: 9, writes: { "a.md": { gen: 9, active: true, since: NOW - 500 } } };
    const converted = roundtrip(convertedRecord(old, NOW, NOW));
    expect(converted.writes["a.md"]).toEqual({ gen: 9, active: true, since: NOW - 500, owner: { unknown: "converted" } });
    expect(converted.generation).toBe(9);
    const c = client(converted, 1, C1);
    ok(send(c, edit(1, NOW - 10)).reply);
    expect(send(c, start(1, writerOf(1), NOW - 5)).reply).toMatchObject({ refused: "write-active" });
    expect(releaseGoneWriters(c.record, [{ path: "a.md", writer: writerOf(1), markGen: 9, checkedAt: NOW }], "host-a").released).toEqual([]);
  });

  test("a flush or abandon ends only the exact live write (CX-S4c)", () => {
    const c = client(emptyRecord());
    ok(send(c, edit(2, NOW - 100)).reply);
    ok(send(c, start(2, writerOf(1), NOW - 90)).reply);
    expect(send(c, flush(2, 1, A, docOf(O1), "a.md", 2, I2)).reply).toMatchObject({ refused: "ref-invalid" });
    expect(send(c, flush(2, 1, A, docOf(O1, 1, 2), "a.md", 2)).reply).toMatchObject({ refused: "ref-invalid" });
    expect(c.record.writes["a.md"]!.active).toBe(true);
    const ended = ok(send(c, flush(2, 1, A, docOf(O1), "a.md", 2)).reply);
    expect(ended).toMatchObject({ ok: "flushed", endedWrite: true });
    expect(c.record.writes["a.md"]).toMatchObject({ active: false, since: NOW - 90 });
    expect(docRow(c)!.flushed!.from).toBe(NOW - 100);
    // Abandon of another write.
    ok(send(c, edit(3, NOW - 50)).reply);
    ok(send(c, start(3, writerOf(1), NOW - 40, docOf(O1), "a.md", I2)).reply);
    expect(send(c, { method: "noteWriteAbandon", path: "a.md", doc: docOf(O1), gen: 3, intent: I1, writeRef: 7 }).reply).toMatchObject({ refused: "ref-invalid" });
    ok(send(c, { method: "noteWriteAbandon", path: "a.md", doc: docOf(O1), gen: 3, intent: I2, writeRef: 7 }).reply);
    expect(c.record.writes["a.md"]).toMatchObject({ active: false, since: NOW - 40 });
    expect(c.record.pendingSince["a.md"]).toBe(NOW - 40);
  });

  test("a new process replaying old bodies: applied ones return the original epoch; unapplied ones apply as old-owner facts; an old start is stale-writer (CX-S8d/e)", () => {
    const c4 = client(emptyRecord(), 4);
    // Epoch 4 never stored these replies, so it never acknowledged them.
    const appliedEdit = ok(send(c4, edit(1, NOW - 100, docOf(O1, 4)), { ackedThrough: 0 }).reply);
    const appliedStart = ok(send(c4, start(1, writerOf(4), NOW - 90, docOf(O1, 4)), { ackedThrough: 0 }).reply);
    // Epoch 5 reconnects; the epoch-4 replies were lost.
    const c5 = client(c4.record, 5, C1, HELPER, 1, 0, { recordId: c4.session.recordId, streamId: c4.session.streamId });
    expect(send(c5, edit(1, NOW - 100, docOf(O1, 4)), { seq: 1, ackedThrough: 0 }).reply).toEqual(appliedEdit);
    expect((send(c5, start(1, writerOf(4), NOW - 90, docOf(O1, 4)), { seq: 2, ackedThrough: 0 }).reply as ReceiptResult).epoch).toBe(4);
    expect(send(c5, start(1, writerOf(4), NOW - 90, docOf(O1, 4)), { seq: 2, ackedThrough: 0 }).reply).toEqual(appliedStart);
    // Unapplied epoch-4 work: an unseen old owner keeps its origin epoch; its start is stale-writer.
    c5.seq = 3;
    c5.acked = 2;
    const oldEdit = ok(send(c5, edit(1, NOW - 80, docOf(O3, 4), "b.md")).reply);
    expect(oldEdit.epoch).toBe(5);
    expect(stream(c5).owners[O3]).toEqual({ epoch: 4 });
    expect(send(c5, start(1, writerOf(4), NOW - 70, docOf(O3, 4), "b.md")).reply).toMatchObject({ refused: "stale-writer", epoch: 5 });
    ok(send(c5, flush(1, 3, A, docOf(O3, 4), "b.md")).reply);
    expect(stream(c5).docs.find((d) => d.path === "b.md")!.doc).toEqual(docOf(O3, 4));
    // The same owner claimed under another epoch is owner-mismatch.
    expect(send(c5, edit(2, NOW - 60, docOf(O3, 5), "b.md")).reply).toMatchObject({ refused: "owner-mismatch" });
  });
});

describe("document identity and adoption (S7, I8)", () => {
  test("equal path, docEpoch and gen under another owner never match a reference, proof or verified row (CX-S7a)", () => {
    const c = client(emptyRecord());
    ok(send(c, edit(3, NOW - 100)).reply);
    ok(send(c, flush(3, 1, A)).reply);
    capture(c, NOW, { readPaths: ["a.md"], readOids: { "a.md": A } });
    verify(c, "1".repeat(40), NOW + 10);
    expect(view(c, [{ path: "a.md", doc: docOf(O1) }]).docs.items[0]!.state).toBe("verified");
    // A reloaded renderer: new owner, same numbers.
    ok(send(c, edit(3, NOW - 5, docOf(O2))).reply);
    expect(send(c, flush(3, 1, A, docOf(O2))).reply).toMatchObject({ refused: "ref-invalid" });
    const v = view(c, [{ path: "a.md", doc: docOf(O2) }]).docs.items[0]!;
    expect(v.state).toBe("debt");
    expect(v.verified).toBeNull();
  });

  test("debt moves only by an explicit adopt from an older-epoch owner (CX-S7c)", () => {
    const c1 = client(emptyRecord(), 1);
    ok(send(c1, edit(2, NOW - 100, docOf(O1, 1))).reply);
    const c2 = client(c1.record, 2, C1, HELPER, c1.seq, c1.acked, { recordId: c1.session.recordId, streamId: c1.session.streamId });
    ok(send(c2, edit(2, NOW - 10, docOf(O2, 2))).reply);
    const before = view(c2, [{ path: "a.md", doc: docOf(O1, 1) }, { path: "a.md", doc: docOf(O2, 2) }]);
    expect(before.thisClient.unflushed.count).toBe(2);
    expect(before.thisClient.owners.items.find((o) => o.owner === O1)!.unflushed.count).toBe(1);
    expect(send(c2, { method: "adopt", path: "a.md", from: docOf(O2, 2), to: docOf(O1, 1) }).reply).toMatchObject({ refused: "adopt-invalid" });
    expect(send(c2, { method: "adopt", path: "b.md", from: docOf(O1, 1), to: docOf(O2, 2) }).reply).toMatchObject({ refused: "adopt-invalid" });
    expect(ok(send(c2, { method: "adopt", path: "a.md", from: docOf(O1, 1), to: docOf(O2, 2) }).reply)).toMatchObject({ ok: "adopted", segments: 1 });
    const row = docRow(c2, docOf(O2, 2))!;
    expect(row.segments).toEqual([{ throughGen: 2, at: NOW - 100, ticket: 2 }]);
    expect(docRow(c2, docOf(O1, 1))).toBeUndefined();
  });
});

describe("blob-bound debt and proof (S5, R5, I7)", () => {
  test("flush A, disk B: debt and age stay, proof mismatch; a newer same-doc flush C captured clears it from the earliest age (CX-S5a/b)", () => {
    const c = client(emptyRecord());
    ok(send(c, edit(1, NOW - 100)).reply);
    ok(send(c, flush(1, 1, A)).reply);
    capture(c, NOW, { snapshot: "1".repeat(40), readPaths: ["a.md"], readOids: { "a.md": B }, sawChange: true });
    verify(c, "1".repeat(40), NOW + 1);
    expect(c.record.oldestUnprotectedEdit).toBe(NOW - 100);
    expect(docRow(c)!.flushed).toMatchObject({ gen: 1, blobOid: A });
    expect(stream(c).proof[0]).toMatchObject({ state: "mismatch", gen: 1 });
    ok(send(c, edit(2, NOW - 50)).reply);
    ok(send(c, flush(2, 3, C)).reply);
    expect(docRow(c)!.flushed).toMatchObject({ gen: 2, blobOid: C, from: NOW - 100 });
    capture(c, NOW + 2, { snapshot: "2".repeat(40), readPaths: ["a.md"], readOids: { "a.md": C } });
    expect(c.record.oldestUnprotectedEdit).toBe(NOW - 100);
    verify(c, "2".repeat(40), NOW + 3);
    expect(c.record.oldestUnprotectedEdit).toBeNull();
    expect(stream(c).verified[0]).toMatchObject({ gen: 2, blobOid: C, snapshot: "2".repeat(40) });
  });

  test("intermediate autosaves A1, A2 coalesce into A3; only A3 captured clears the debt, with A1's age (CX-S5d)", () => {
    const c = client(emptyRecord());
    const blobs = [A, B, C];
    for (let g = 1; g <= 3; g++) {
      ok(send(c, edit(g, NOW - 100 + g * 10)).reply);
      ok(send(c, flush(g, 2 * g - 1, blobs[g - 1]!)).reply);
    }
    expect(docRow(c)!.flushed).toMatchObject({ gen: 3, blobOid: C, from: NOW - 90 });
    capture(c, NOW, { readPaths: ["a.md"], readOids: { "a.md": C } });
    expect(docRow(c)).toBeUndefined();
    expect(c.record.captured).toEqual([{ seq: 1, from: NOW - 90 }]);
  });

  test("deleted, unreadable and pending paths keep the debt; proof eviction is counted and persists (CX-S5c, CX-S10c)", () => {
    const c = client(emptyRecord());
    ok(send(c, edit(1, NOW - 100)).reply);
    ok(send(c, flush(1, 1, A)).reply);
    capture(c, NOW, { goneConfirmed: ["a.md"] });
    capture(c, NOW + 1, { pendingPaths: ["a.md"] });
    capture(c, NOW + 2, { readPaths: ["a.md"], pendingPaths: ["a.md"], readOids: { "a.md": A } });
    expect(docRow(c)!.flushed).toMatchObject({ blobOid: A, from: NOW - 100 });
    // Fill the proof list past its bound with settled documents.
    for (let i = 0; i < MAX_PROOF; i++) {
      ok(send(c, edit(1, NOW - 10, docOf(O1), `d/${i}.md`)).reply);
      ok(send(c, flush(1, c.seq - 1, B, docOf(O1), `d/${i}.md`)).reply);
      if (i % 64 === 63) capture(c, NOW + 10 + i, { readPaths: Array.from({ length: 64 }, (_, k) => `d/${i - 63 + k}.md`), readOids: Object.fromEntries(Array.from({ length: 64 }, (_, k) => [`d/${i - 63 + k}.md`, B])) });
    }
    expect(ledger(c).counters.proofEvicted).toBe(1);
    // The evicted row was a.md's (oldest acknowledgement): its debt is untouched.
    expect(stream(c).proof.some((p) => p.path === "a.md")).toBe(false);
    expect(docRow(c)!.flushed).toMatchObject({ blobOid: A, from: NOW - 100 });
    const v = view(c, [{ path: "a.md", doc: docOf(O1) }]);
    expect(v.docs.items[0]!.state).toBe("debt");
    expect(v.vault.counters.proofEvicted).toBe(1);
    expect(roundtrip(c.record).oldestUnprotectedEdit).toBe(NOW - 100);
  });

  test("capture A then a later capture with B, verified at B: A's verified row keeps A's exact capture snapshot (R5)", () => {
    const c = client(emptyRecord());
    ok(send(c, edit(1, NOW - 100)).reply);
    ok(send(c, flush(1, 1, A)).reply);
    capture(c, NOW, { snapshot: "a1".repeat(20), readPaths: ["a.md"], readOids: { "a.md": A } });
    expect(stream(c).proof[0]).toMatchObject({ state: "captured", snapshotSeq: 1, snapshot: "a1".repeat(20) });
    capture(c, NOW + 1, { snapshot: "b2".repeat(20), readPaths: ["a.md"], readOids: { "a.md": B }, sawChange: true });
    verify(c, "b2".repeat(20), NOW + 2);
    expect(stream(c).verified).toEqual([{ doc: docOf(O1), path: "a.md", gen: 1, blobOid: A, snapshot: "a1".repeat(20), snapshotSeq: 1, at: NOW + 2 }]);
    expect(stream(c).proof).toEqual([]);
  });

  test("verification of a snapshot with no recorded capture promotes nothing", () => {
    const c = client(emptyRecord());
    ok(send(c, edit(1, NOW - 100)).reply);
    ok(send(c, flush(1, 1, A)).reply);
    capture(c, NOW, { readPaths: ["a.md"], readOids: { "a.md": A } });
    c.record = roundtrip(applyVerified(c.record, { snapshot: "9".repeat(40), ref: "r", seq: null, coverage: null }, NOW + 1));
    expect(stream(c).verified).toEqual([]);
    expect(stream(c).proof[0]!.state).toBe("captured");
  });
});

describe("damage, conversion and unknown versions (S2, R1, I12)", () => {
  test("a damaged ledger keeps deadline fields and active marks, sets a reset floor and needs re-activation (CX-S2c)", () => {
    const c = client(emptyRecord());
    ok(send(c, edit(1, NOW - 100)).reply);
    ok(send(c, start(1, writerOf(1), NOW - 90)).reply);
    const raw = JSON.parse(JSON.stringify(c.record));
    raw.receipts.clients[C1].appliedThrough = 99; // replies no longer cover (acked, applied]
    raw.writes["b.md"] = { gen: 1, active: true, since: NOW - 300, owner: { clientId: "bad" } };
    const parsed = parseRecordDetailed(raw)!;
    expect(parsed.kind).toBe("ledger-damaged");
    expect(parseRecord(raw)).toBeNull();
    const repaired = roundtrip(repairedLedgerRecord(parsed.record, (parsed as { damaged: unknown }).damaged, NOW, NOW));
    expect(repaired.writes["a.md"]).toMatchObject({ active: true, since: NOW - 90, owner: { clientId: C1 } });
    expect(repaired.writes["b.md"]).toEqual({ gen: 1, active: true, since: NOW - 300, owner: { unknown: "damaged-ledger" } });
    const l = ledgerOf(repaired)!;
    expect(l.activation).toBeNull();
    expect(l.resetFloor).toEqual({ from: NOW - 100, reason: "damaged-ledger", at: NOW });
    expect(l.counters.resets).toBe(1);
    expect(l.captureQuarantine).toBeNull();
    expect(repaired.oldestUnprotectedEdit).toBe(NOW - 300);
    // Capture keeps the tagged path pending (the capture reads writes as before) and nothing clears the floor.
    const after = applyCapture(repaired, outcome(repaired, NOW, { pendingPaths: ["a.md", "b.md"] })).record;
    expect(after.oldestUnprotectedEdit).toBe(NOW - 300);
    expect(applyReceipt(repaired, c.session, { id: 1, vault: "v", seq: 3, ackedThrough: 2, ...edit(2, NOW) } as SeqRequest, NOW).reply).toMatchObject({ error: "activation-refused" });
    expect(stampBroken({ recordId: l.recordId === c.session.recordId ? "x" : c.session.recordId, reset: false }, repaired)).not.toBeNull();
  });

  test("an unreadable or other-schema record converts into a quarantined record that keeps the generation floor", () => {
    const damaged = convertedRecord(undefined, NOW - 1000, NOW);
    expect(ledgerOf(damaged)!.captureQuarantine).toEqual({ since: NOW - 1000, reason: "incomplete-guards" });
    expect("unsafe" in recordSafety(damaged)).toBe(true);
    const old = { schema: 2, generation: 41, writing: { "a.md": NOW - 700 }, receipts: { counters: { resets: 2, proofEvicted: 5 } } };
    const r = roundtrip(convertedRecord(old, NOW, NOW));
    expect(r.generation).toBe(41);
    expect(r.writes["a.md"]).toEqual({ gen: 41, active: true, since: NOW - 700, owner: { unknown: "converted" } });
    expect(ledgerOf(r)!.counters).toEqual({ resets: 3, proofEvicted: 5 });
    expect(ledgerOf(r)!.resetFloor).toMatchObject({ from: NOW - 700, reason: "converted" });
  });

  test("an unknown ledger version is opaque: receipts and capture refuse, its times still count", () => {
    const record = { ...emptyRecord(), receipts: { v: 3, future: { since: NOW - 999 } } };
    const parsed = parseRecordDetailed(JSON.parse(JSON.stringify(record)))!;
    expect(parsed.kind).toBe("unsupported");
    expect(parsed.record.oldestUnprotectedEdit).toBe(NOW - 999);
    expect("unsafe" in recordSafety(parsed.record)).toBe(true);
    const session: ReceiptSession = { helper: HELPER, clientId: C1, clientEpoch: 1, writer: null, recordId: null, streamId: null };
    expect(openStream(parsed.record, session, attest(), { id: 0, method: "openStream", vault: "v", knownRecordId: null, knownStreamId: null, nextSeq: 1, ackedThrough: 0 }, NOW, "sha1").reply).toMatchObject({ error: "unsupported-ledger" });
  });

  test("a healthy record without receipts never gains a ledger or owner field through legacy operations (I14)", () => {
    let r = emptyRecord();
    r = legacyFlush(r, { upTo: 0, allDocuments: true }, NOW);
    r = applyCapture(r, outcome(r, NOW, { readPaths: ["a.md"], readOids: { "a.md": A } })).record;
    expect("receipts" in r).toBe(false);
    expect(JSON.stringify(r)).not.toContain("owner");
  });
});

describe("status view (S10, I13)", () => {
  test("counts come from the whole record; a counts-only reply has no items; other clients add counts and times only (CX-S10a/b)", () => {
    const c1 = client(emptyRecord(), 1, C1);
    ok(send(c1, edit(1, NOW - 100, docOf(O1), "secret/other.md")).reply);
    const c2 = client(c1.record, 1, C2);
    ok(send(c2, edit(1, NOW - 10, docOf(O2), "mine.md")).reply);
    const full = view(c2, [{ path: "mine.md", doc: docOf(O2) }]);
    expect(full.vault.otherClientDebt).toEqual({ count: 1, oldestAt: NOW - 100, clients: 1 });
    expect(full.thisClient.unflushed).toEqual({ count: 1, oldestAt: NOW - 10 });
    expect(JSON.stringify(full)).not.toContain("secret/other.md");
    const countsOnly = view(c2, [{ path: "mine.md", doc: docOf(O2) }], 0);
    expect(countsOnly.docs).toEqual({ count: 1, items: [], omitted: 1 });
    expect(countsOnly.thisClient.owners).toMatchObject({ count: 1, items: [], omitted: 1 });
    expect(countsOnly.vault.oldestUnprotectedEdit).toBe(NOW - 100);
  });
});

describe("size at bounds (U8: size only, no performance claim)", () => {
  test("one client at the document bound with full segments and references stays a bounded, strictly parseable record", () => {
    const c = client(emptyRecord());
    for (let i = 0; i < MAX_DOCS; i++) {
      for (let g = 1; g <= 5; g++) {
        const req = { id: 1, vault: "v", seq: c.seq, ackedThrough: c.seq - 1, ...edit(g, NOW - g, docOf(O1), `folder/deeper/document-${i}.md`) } as SeqRequest;
        const out = applyReceipt(c.record, c.session, req, NOW);
        expect(isReceiptError(out.reply)).toBe(false);
        c.record = out.record;
        c.seq += 1;
      }
    }
    const bytes = Buffer.byteLength(`${JSON.stringify(c.record, null, 2)}\n`);
    expect(stream(c).docs.every((d) => d.segments.length === 4 && d.editRefs.length === 4)).toBe(true);
    expect(bytes).toBeLessThan(2 * 1024 * 1024);
    roundtrip(c.record);
  });
});

describe("ledger repair keeps or establishes the capture quarantine (§11, E1 review F1)", () => {
  const repairOf = (raw: Record<string, unknown>) => {
    const parsed = parseRecordDetailed(raw)!;
    expect(parsed.kind).toBe("ledger-damaged");
    return roundtrip(repairedLedgerRecord(parsed.record, (parsed as { damaged: unknown }).damaged, NOW, NOW));
  };
  const damage = (record: DeadlineRecord, change: (raw: any) => void) => {
    const raw = JSON.parse(JSON.stringify(record));
    change(raw);
    return raw;
  };
  const writing = () => {
    const c = client(emptyRecord());
    ok(send(c, edit(1, NOW - 100)).reply);
    ok(send(c, start(1, writerOf(1), NOW - 90)).reply);
    return c;
  };

  test("an existing quarantine survives unrelated ledger damage, repeated repair and reload", () => {
    let r = roundtrip(convertedRecord(undefined, NOW - 1000, NOW));
    const damages: ((raw: any) => void)[] = [
      (raw) => { raw.receipts.counters.resets = "broken"; },
      (raw) => { raw.receipts.counters.proofEvicted = -1; },
      (raw) => { raw.receipts.clients = []; },
    ];
    for (const change of damages) {
      r = repairOf(damage(r, change));
      expect(ledgerOf(r)!.captureQuarantine).toEqual({ since: NOW - 1000, reason: "incomplete-guards" });
      expect("unsafe" in recordSafety(r)).toBe(true);
      // A reload with no further damage is strictly valid and changes nothing.
      expect(parseRecordDetailed(JSON.parse(JSON.stringify(r)))!.kind).toBe("ok");
      expect(roundtrip(r)).toEqual(r);
    }
    expect(ledgerOf(r)!.counters.resets).toBe(3); // conversion 1; the unreadable counter restarts at 1; then 2, 3
  });

  test("a live write reference without its exact mark, or any unreadable guard evidence, quarantines; every remaining guard is kept", () => {
    const variants: [string, (raw: any) => void][] = [
      ["mark deleted", (raw) => { delete raw.writes["a.md"]; }],
      ["mark seq disagrees", (raw) => { raw.writes["a.md"].owner.seq = 9; }],
      ["mark token disagrees", (raw) => { raw.writes["a.md"].gen = 1; }],
      ["tagged mark made inactive", (raw) => { raw.writes["a.md"].active = false; }],
      ["ledger removed, tagged mark left", (raw) => { delete raw.receipts; }],
      ["ledger unreadable", (raw) => { raw.receipts = "torn"; }],
      ["write reference unreadable", (raw) => { raw.receipts.clients[C1].docs[0].write = "?"; }],
      ["document list unreadable", (raw) => { raw.receipts.clients[C1].docs = null; }],
      ["quarantine field damaged", (raw) => { raw.receipts.captureQuarantine = { since: "x" }; }],
      ["quarantine field missing", (raw) => { delete raw.receipts.captureQuarantine; }],
    ];
    for (const [name, change] of variants) {
      const c = writing();
      const r = repairOf(damage(c.record, change));
      expect([name, ledgerOf(r)!.captureQuarantine?.reason]).toEqual([name, "incomplete-guards"]);
      expect("unsafe" in recordSafety(r)).toBe(true);
      if (name !== "mark deleted") expect([name, r.writes["a.md"]?.active]).toEqual([name, true]);
      // Repeated repair of the repaired record keeps it.
      expect(ledgerOf(repairOf(damage(r, (raw) => { raw.receipts.counters.resets = "x"; })))!.captureQuarantine?.reason).toBe("incomplete-guards");
    }
  });

  test("positive completeness rule: unrelated damage with every live reference matched by its exact mark keeps capture open", () => {
    const c = writing();
    const r = repairOf(damage(c.record, (raw) => { raw.receipts.counters.resets = "x"; }));
    expect(ledgerOf(r)!.captureQuarantine).toBeNull();
    expect(r.writes["a.md"]).toMatchObject({ active: true, owner: { clientId: C1, seq: 2 } });
    // A reference that was dropped leaves its mark as a guard (an orphan), not a lost guard.
    const orphan = repairOf(damage(c.record, (raw) => { raw.receipts.clients[C1].docs = []; raw.receipts.counters.proofEvicted = "x"; }));
    expect(ledgerOf(orphan)!.captureQuarantine).toBeNull();
    expect(orphan.writes["a.md"]).toMatchObject({ active: true, owner: { clientId: C1 } });
    expect("stamp" in recordSafety(orphan)).toBe(true);
  });
});

describe("path-keyed maps hold every valid file name (E1 review F2)", () => {
  const NAMES = ["__proto__", "constructor", "toString"];
  const has = (map: object, key: string) => Object.prototype.hasOwnProperty.call(map, key);

  test("write start, capture settlement, exact completion and capture keep own entries through JSON and clone", () => {
    for (const name of NAMES) {
      const c = client(emptyRecord());
      ok(send(c, edit(1, NOW - 100, docOf(O1), name)).reply);
      const { token } = ok(send(c, start(1, writerOf(1), NOW - 90, docOf(O1), name)).reply) as Extract<ReceiptResult, { ok: "write-started" }>;
      expect([name, has(c.record.writes, name)]).toEqual([name, true]);
      expect(c.record.writes[name]).toMatchObject({ active: true, gen: token, owner: { path: name, seq: 2 } });
      expect(has(structuredClone(c.record).writes, name)).toBe(true);
      expect(send(c, start(1, writerOf(1), NOW - 80, docOf(O1), name, I2)).reply).toMatchObject({ refused: "write-active" });
      // A capture that leaves the path pending keeps the active mark and records the path's own floor.
      capture(c, NOW - 50, { pendingPaths: [name], pendingFloor: NOW - 60 });
      expect([name, has(c.record.writes, name), c.record.writes[name]?.active]).toEqual([name, true, true]);
      expect([name, has(c.record.pendingSince, name), c.record.pendingSince[name]]).toEqual([name, true, NOW - 60]);
      expect(ok(send(c, flush(1, 1, A, docOf(O1), name, 2)).reply)).toMatchObject({ ok: "flushed", endedWrite: true });
      expect(c.record.writes[name]).toMatchObject({ active: false });
      capture(c, NOW, { readPaths: [name], readOids: { [name]: A } });
      expect([name, has(c.record.pendingSince, name)]).toEqual([name, false]);
      expect(docRow(c, docOf(O1), name)).toBeUndefined();
      expect(stream(c).proof[0]).toMatchObject({ path: name, state: "captured" });
    }
  });

  test("abandon, gone release, a folder floor, legacy starts, conversion and ledger repair keep own entries", () => {
    for (const name of NAMES) {
      const c = client(emptyRecord());
      ok(send(c, edit(1, NOW - 100, docOf(O1), name)).reply);
      ok(send(c, start(1, writerOf(1), NOW - 90, docOf(O1), name)).reply);
      // Ledger repair keeps the own mark (an empty damaged ledger also quarantines).
      const repaired = roundtrip(repairedLedgerRecord(c.record, {}, NOW, NOW));
      expect([name, has(repaired.writes, name), repaired.writes[name]?.active]).toEqual([name, true, true]);
      ok(send(c, { method: "noteWriteAbandon", path: name, doc: docOf(O1), gen: 1, intent: I1, writeRef: 2 }).reply);
      expect([name, has(c.record.pendingSince, name), c.record.pendingSince[name]]).toEqual([name, true, NOW - 90]);
      const { token } = ok(send(c, start(1, writerOf(1), NOW - 70, docOf(O1), name, I2)).reply) as Extract<ReceiptResult, { ok: "write-started" }>;
      const gone = releaseGoneWriters(c.record, [{ path: name, writer: writerOf(1), markGen: token, checkedAt: NOW }], "host-a");
      expect(gone.released).toEqual([name]);
      expect(roundtrip(gone.record).writes[name]).toMatchObject({ active: false });
      // A folder that could not be listed keeps its own floor.
      const listed = roundtrip(applyCapture(emptyRecord(), outcome(emptyRecord(), NOW, { unlistedFolders: [name], pendingFloor: NOW - 5 })).record);
      expect([name, has(listed.unlistedSince, name), listed.unlistedSince[name]]).toEqual([name, true, NOW - 5]);
      // The untagged API.
      const legacy = roundtrip(legacyStart(emptyRecord(), [name], NOW - 3));
      expect([name, has(legacy.writes, name)]).toEqual([name, true]);
      expect(() => legacyStart(legacy, [name], NOW)).toThrow(/already active/);
      // Conversion of a record parsed from text (JSON.parse makes `__proto__` an own key).
      const text = `{"schema":2,"generation":4,"writes":{${JSON.stringify(name)}:{"gen":3,"active":true,"since":${NOW - 400}}},"pendingSince":{${JSON.stringify(name)}:${NOW - 500}}}`;
      const converted = roundtrip(convertedRecord(JSON.parse(text), NOW, NOW));
      expect([name, has(converted.writes, name), converted.writes[name]?.owner]).toEqual([name, true, { unknown: "converted" }]);
      expect([name, converted.pendingSince[name]]).toEqual([name, NOW - 500]);
    }
  });
});
