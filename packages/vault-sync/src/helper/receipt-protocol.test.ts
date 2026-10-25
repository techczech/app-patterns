import { describe, expect, test } from "bun:test";
import type { HelperIncarnation, WriterIncarnation } from "../receipt-ledger.ts";
import type { ReceiptStatusView } from "../receipt-status.ts";
import { attest, goneWriterProofs, helperIncarnation, sealed, type RecordHint } from "./activation.ts";
import { judge, parseStartTime, type ProcessObserver } from "./process-observer.ts";
import { MAX_REPLY_BYTES } from "./protocol.ts";
import {
  checkLaneResponse, checkOpenStreamResult, checkReceiptResult, checkReceiptStatusView, checkReceiptsHelloReply, LaneError, parseLaneRequest, parseReceiptsHello, versionAtLeast,
} from "./receipt-protocol.ts";
import { statusLine } from "./receipt-session.ts";

const CLIENT = "c".repeat(32);
const OWNER = "a".repeat(32);
const INTENT = "1".repeat(32);
const REC = "e".repeat(32);
const STREAM = "f".repeat(32);
const doc = { owner: OWNER, ownerEpoch: 4, docEpoch: 1 };
const writer: WriterIncarnation = { host: "h", pid: 100, startedAt: 1_700_000_000_000, clientEpoch: 4 };
const helloBody = { type: "hello", protocol: 2, lane: "receipts", client: "app", clientId: CLIENT, clientEpoch: 4, writer, capabilities: ["receipts-2"] };
const at = 1_800_000_000_000;
const j = (v: unknown) => JSON.stringify(v);
const code = (fn: () => unknown) => {
  try {
    fn();
    return "accepted";
  } catch (error) {
    return error instanceof LaneError ? error.code : `threw ${String(error)}`;
  }
};

describe("receipts hello (strict)", () => {
  test("exact hello parses; every deviation is refused", () => {
    expect(parseReceiptsHello(j(helloBody))).toEqual(helloBody as never);
    expect(parseReceiptsHello(j({ ...helloBody, writer: null })).writer).toBeNull();
    expect(code(() => parseReceiptsHello(j({ ...helloBody, extra: 1 })))).toBe("bad-request");
    const { writer: _w, ...missing } = helloBody;
    expect(code(() => parseReceiptsHello(j(missing)))).toBe("bad-request");
    expect(code(() => parseReceiptsHello(j({ ...helloBody, lane: "control" })))).toBe("protocol-mismatch");
    expect(code(() => parseReceiptsHello(j({ ...helloBody, clientId: "C".repeat(32) })))).toBe("bad-request");
    expect(code(() => parseReceiptsHello(j({ ...helloBody, clientEpoch: 0 })))).toBe("bad-request");
    expect(code(() => parseReceiptsHello(j({ ...helloBody, writer: { ...writer, clientEpoch: 3 } })))).toBe("bad-request");
    expect(code(() => parseReceiptsHello(j({ ...helloBody, writer: { ...writer, extra: 1 } })))).toBe("bad-request");
    expect(code(() => parseReceiptsHello(j({ ...helloBody, capabilities: ["receipts-2", "more"] })))).toBe("bad-request");
  });

  test("the client accepts only an exact, level-1, new-enough answer; an old helper's refusal means unavailable", () => {
    const ok = { type: "hello", ok: true, protocol: 2, lane: "receipts", helperVersion: "0.2.0", engineLevel: 1, capabilities: ["receipts-2"] };
    expect(checkReceiptsHelloReply(j(ok))).toMatchObject({ ok: true });
    expect(code(() => checkReceiptsHelloReply(j({ ...ok, engineLevel: 2 })))).toBe("bad-request");
    expect(code(() => checkReceiptsHelloReply(j({ ...ok, helperVersion: "0.1.0-spike" })))).toBe("bad-request");
    expect(code(() => checkReceiptsHelloReply(j({ ...ok, helperVersion: "0.1.9" })))).toBe("bad-request");
    expect(code(() => checkReceiptsHelloReply(j({ ...ok, extra: true })))).toBe("bad-request");
    expect(code(() => checkReceiptsHelloReply(j({ ...ok, protocol: 1 })))).toBe("bad-request");
    expect(checkReceiptsHelloReply(j({ type: "hello", ok: false, protocol: 1, error: { code: "protocol-mismatch", message: "this helper speaks protocol 1" } }))).toEqual({ ok: false, code: "protocol-mismatch", message: "this helper speaks protocol 1" });
    expect(versionAtLeast("0.10.0", "0.2.0")).toBe(true);
    expect(versionAtLeast("1.0.0", "0.2.0")).toBe(true);
    expect(versionAtLeast("0.2.0-rc1", "0.2.0")).toBe(false);
  });
});

describe("receipt requests (strict, before any record access)", () => {
  const edit = { id: 3, method: "noteEdit", vault: "v", seq: 1, ackedThrough: 0, path: "notes/a.md", doc, throughGen: 2, at };
  test("each method's exact shape parses", () => {
    expect(parseLaneRequest(j(edit))).toEqual(edit as never);
    const start = { id: 4, method: "noteWriteStart", vault: "v", seq: 2, ackedThrough: 0, path: "notes/a.md", doc, gen: 2, intent: INTENT, writer, at };
    expect(parseLaneRequest(j(start))).toEqual(start as never);
    const flush = { id: 5, method: "noteFlush", vault: "v", seq: 3, ackedThrough: 0, path: "notes/a.md", doc, gen: 2, intent: INTENT, editRef: 1, writeRef: null, blobOid: "b".repeat(64) };
    expect(parseLaneRequest(j(flush))).toEqual(flush as never);
    const open = { id: 6, method: "openStream", vault: "v", knownRecordId: null, knownStreamId: null, nextSeq: 1, ackedThrough: 0 };
    expect(parseLaneRequest(j(open))).toEqual(open as never);
    const status = { id: 7, method: "receiptStatus", vault: "v", want: [{ path: "notes/a.md", doc }] };
    expect(parseLaneRequest(j(status))).toEqual(status as never);
  });

  test("no request can carry filesystem scope, remotes, commands, attestation, tokens or proofs; malformed fields are refused with the request id", () => {
    for (const extra of [{ root: "/" }, { paths: ["x"] }, { allDocuments: true }, { upTo: 1 }, { token: 1 }, { ticket: 1 }, { remote: "origin" }, { attestation: {} }, { proofs: [] }, { command: "rm" }]) {
      expect(code(() => parseLaneRequest(j({ ...edit, ...extra })))).toBe("bad-request");
    }
    expect(code(() => parseLaneRequest(j({ ...edit, path: "../x" })))).toBe("bad-request");
    expect(code(() => parseLaneRequest(j({ ...edit, path: "/etc/passwd" })))).toBe("bad-request");
    expect(code(() => parseLaneRequest(j({ ...edit, seq: 0 })))).toBe("bad-request");
    expect(code(() => parseLaneRequest(j({ ...edit, vault: "../v" })))).toBe("bad-request");
    expect(code(() => parseLaneRequest(j({ ...edit, doc: { ...doc, owner: "x" } })))).toBe("bad-request");
    expect(code(() => parseLaneRequest(j({ ...edit, method: "syncNow" })))).toBe("unknown-method");
    expect(code(() => parseLaneRequest(j({ id: 1, method: "receiptStatus", vault: "v", want: Array.from({ length: 65 }, () => ({ path: "notes/a.md", doc })) })))).toBe("bad-request");
    try {
      parseLaneRequest(j({ ...edit, id: 77, upTo: 1 }));
    } catch (error) {
      expect((error as LaneError).id).toBe(77);
    }
    // Writer fields are checked for shape only: another writer is not refused here (the engine decides after dedup).
    expect(parseLaneRequest(j({ id: 4, method: "noteWriteStart", vault: "v", seq: 2, ackedThrough: 0, path: "notes/a.md", doc, gen: 2, intent: INTENT, writer: { ...writer, pid: 999, clientEpoch: 9 }, at })).method).toBe("noteWriteStart");
  });
});

describe("client reply validation", () => {
  const editReq = { id: 9, method: "noteEdit" as const, vault: "v", seq: 5, ackedThrough: 4, path: "notes/a.md", doc, throughGen: 2, at };
  const applied = { seq: 5, recordId: REC, durable: true, epoch: 4, ok: "edit", ticket: 7, retiredRefs: [] };

  test("results must answer this seq, this record, an epoch no later than the client's and this method", () => {
    expect(checkReceiptResult(applied, editReq, REC, 4)).toEqual(applied as never);
    expect(checkReceiptResult({ ...applied, epoch: 3 }, editReq, REC, 4)).toMatchObject({ epoch: 3 });
    expect(checkReceiptResult({ seq: 5, recordId: REC, durable: true, epoch: 4, refused: "gen-mismatch" }, editReq, REC, 4)).toMatchObject({ refused: "gen-mismatch" });
    for (const wrong of [{ ...applied, seq: 6 }, { ...applied, recordId: "d".repeat(32) }, { ...applied, epoch: 5 }, { ...applied, durable: false }, { ...applied, extra: 1 }, { ...applied, ok: "flushed", ackGen: 1, endedWrite: false, ticket: undefined, retiredRefs: undefined }]) {
      expect(code(() => checkReceiptResult(JSON.parse(j(wrong)), editReq, REC, 4))).toBe("bad-request");
    }
    expect(code(() => checkReceiptResult({ seq: 5, recordId: REC, durable: true, epoch: 4, refused: "made-up" }, editReq, REC, 4))).toBe("bad-request");
  });

  test("envelopes: exact keys, known codes, well-formed stream identities", () => {
    expect(checkLaneResponse(j({ id: 1, ok: true, result: {} }))).toEqual({ id: 1, ok: true, result: {} });
    const stream = { recordId: REC, streamId: STREAM, base: 0, appliedThrough: 3, ackedThrough: 2 };
    expect(checkLaneResponse(j({ id: 1, ok: false, error: { code: "stream-required", message: "m", stream } }))).toMatchObject({ error: { stream } });
    expect(code(() => checkLaneResponse(j({ id: 1, ok: false, error: { code: "stream-required", message: "m", stream: { ...stream, base: 5 } } })))).toBe("bad-request");
    expect(code(() => checkLaneResponse(j({ id: 1, ok: false, error: { code: "made-up", message: "m" } })))).toBe("bad-request");
    expect(code(() => checkLaneResponse(j({ id: 1, ok: true, result: {}, extra: 1 })))).toBe("bad-request");
    expect(code(() => checkLaneResponse(j({ id: null, ok: true, result: {} })))).toBe("bad-request");
  });

  test("openStream: a new stream starts at nextSeq - 1; a retained one keeps the named identities", () => {
    const limits = { window: 4, maxClients: 4, maxOwners: 64, maxDocs: 256, maxSegments: 4, maxEditRefs: 4, maxActiveWrites: 16, maxProof: 256, maxVerified: 256, maxWant: 64 };
    const result = { recordId: REC, streamId: STREAM, rebased: true, objectFormat: "sha1", base: 20, appliedThrough: 20, ackedThrough: 20, window: 4, limits, owners: { count: 0, items: [], omitted: 0 } };
    const req = { id: 1, method: "openStream" as const, vault: "v", knownRecordId: null, knownStreamId: null, nextSeq: 21, ackedThrough: 0 };
    expect(checkOpenStreamResult(result, req)).toMatchObject({ base: 20 });
    expect(code(() => checkOpenStreamResult({ ...result, base: 0, ackedThrough: 0, appliedThrough: 0 }, req))).toBe("bad-request");
    const retained = { ...req, knownRecordId: REC, knownStreamId: STREAM, ackedThrough: 20 };
    expect(checkOpenStreamResult({ ...result, rebased: false }, retained)).toMatchObject({ rebased: false });
    expect(code(() => checkOpenStreamResult({ ...result, rebased: false, streamId: "d".repeat(32) }, retained))).toBe("bad-request");
    expect(code(() => checkOpenStreamResult({ ...result, rebased: false }, { ...retained, ackedThrough: 21 }))).toBe("bad-request");
    expect(code(() => checkOpenStreamResult({ ...result, extra: 1 }, req))).toBe("bad-request");
  });
});

function view(want: Array<{ path: string; doc: typeof doc }>, items = want.length): ReceiptStatusView {
  const agg = { count: 0, oldestAt: null };
  return {
    recordId: REC, observedGeneration: 3, observedAt: at, activation: null, captureQuarantine: null,
    stream: { clientId: CLIENT, streamId: STREAM, epochHighWater: 4, sessionEpoch: 4, base: 0, appliedThrough: 2, ackedThrough: 1, replies: 1, docs: 1, limits: { window: 4, maxClients: 4, maxOwners: 64, maxDocs: 256, maxSegments: 4, maxEditRefs: 4, maxActiveWrites: 16, maxProof: 256, maxVerified: 256, maxWant: 64 } },
    vault: {
      oldestUnprotectedEdit: at, legacyVaultWide: agg, legacyPerPath: agg, capturedUnverified: agg, pending: agg, unlisted: agg,
      activeWrites: { untagged: agg, thisClient: agg, otherClient: agg, unknownOwner: agg }, otherClientDebt: { count: 7, oldestAt: at - 5, clients: 2 },
      captureQuarantine: null, resetFloor: null, counters: { resets: 0, proofEvicted: 0 },
    },
    thisClient: { unflushed: { count: 1, oldestAt: at }, blobDebt: agg, activeWrites: agg, owners: { count: 0, items: [], omitted: 0 } },
    docs: {
      count: want.length,
      items: want.slice(0, items).map((w) => ({ path: w.path, doc: w.doc, state: "debt", unflushedThroughGen: 2, flushed: null, proof: null, verified: null, activeWrite: false })),
      omitted: want.length - Math.min(items, want.length),
    },
  } as ReceiptStatusView;
}

/** What a status for this test's client at epoch 4 must match. */
const expect4 = (stream: { recordId: string; streamId: string; objectFormat: "sha1" | "sha256" } | null) => ({ clientId: CLIENT, clientEpoch: 4, stream });

describe("receipt status validation and sampling", () => {
  const want = [{ path: "notes/a.md", doc }, { path: "notes/b.md", doc }];
  test("rows are exactly the requested documents in order; omissions are counted, never hidden; other clients only as counts", () => {
    expect(checkReceiptStatusView(JSON.parse(j(view(want))), want, expect4({ recordId: REC, streamId: STREAM, objectFormat: "sha1" })).docs.count).toBe(2);
    expect(checkReceiptStatusView(JSON.parse(j(view(want, 0))), want, expect4(null)).docs).toEqual({ count: 2, items: [], omitted: 2 });
    expect(code(() => checkReceiptStatusView(JSON.parse(j(view(want))), [...want].reverse(), expect4(null)))).toBe("bad-request");
    expect(code(() => checkReceiptStatusView(JSON.parse(j(view(want))), want.slice(0, 1), expect4(null)))).toBe("bad-request");
    expect(code(() => checkReceiptStatusView(JSON.parse(j(view(want))), want, { clientId: "d".repeat(32), clientEpoch: 4, stream: null }))).toBe("bad-request");
    expect(code(() => checkReceiptStatusView(JSON.parse(j(view(want))), want, expect4({ recordId: "d".repeat(32), streamId: STREAM, objectFormat: "sha1" })))).toBe("bad-request");
    const otherDoc = JSON.parse(j(view(want)));
    otherDoc.docs.items[0].doc.owner = "b".repeat(32);
    expect(code(() => checkReceiptStatusView(otherDoc, want, expect4(null)))).toBe("bad-request");
    const zeroWithTime = JSON.parse(j(view(want)));
    zeroWithTime.vault.pending = { count: 0, oldestAt: at };
    expect(code(() => checkReceiptStatusView(zeroWithTime, want, expect4(null)))).toBe("bad-request");
    const leaked = JSON.parse(j(view(want)));
    leaked.vault.otherClientDebt.paths = ["secret.md"];
    expect(code(() => checkReceiptStatusView(leaked, want, expect4(null)))).toBe("bad-request");
    const verifiedWithoutRow = JSON.parse(j(view(want)));
    verifiedWithoutRow.docs.items[0].state = "verified";
    expect(code(() => checkReceiptStatusView(verifiedWithoutRow, want, expect4(null)))).toBe("bad-request");
  });

  test("an oversized status keeps every count and says exactly how many rows it left out", () => {
    const huge = view(want);
    huge.docs = { count: 5_000, items: Array.from({ length: 5_000 }, (_, i) => ({ ...huge.docs.items[0]!, path: `notes/${"x".repeat(900)}-${i}.md` })), omitted: 0 };
    const line = statusLine(1, huge)!;
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_REPLY_BYTES);
    const sent = JSON.parse(line).result;
    expect(sent.docs.count).toBe(5_000);
    expect(sent.docs.items.length + sent.docs.omitted).toBe(5_000);
    expect(sent.vault.otherClientDebt).toEqual({ count: 7, oldestAt: at - 5, clients: 2 });
  });
});

describe("incarnations: activation and gone writers", () => {
  const self: HelperIncarnation = { host: "h", pid: 200, startedAt: 1_700_000_100_000, helperVersion: "0.2.0" };
  const prior: HelperIncarnation = { host: "h", pid: 150, startedAt: 1_700_000_050_000, helperVersion: "0.2.0" };
  const observer = (answers: Record<number, "there" | "gone" | "unknown" | "never" | "throw">, seen: number[] = []): ProcessObserver => ({
    startTime: async () => null,
    observe: (pid) => {
      seen.push(pid);
      const a = answers[pid] ?? "unknown";
      if (a === "never") return new Promise(() => undefined);
      if (a === "throw") return Promise.reject(new Error("ps failed"));
      return Promise.resolve(a);
    },
  });
  const report = { work: "ended", socket: "removed", claims: "released" } as const;

  test("first activation and the same helper attest with no prior", async () => {
    expect(await attest(self, null, null, observer({}))).toEqual({ attestation: { helper: self, exclusive: true, prior: null } });
    expect(await attest(self, { ...self }, null, observer({}))).toEqual({ attestation: { helper: self, exclusive: true, prior: null } });
  });

  test("a prior helper hands over only on its exact sealed report, or is accepted only when observed gone", async () => {
    expect(await attest(self, prior, { by: prior, report }, observer({ 150: "there" }))).toEqual({ attestation: { helper: self, exclusive: true, prior: { by: prior, quiescence: "handover" } } });
    for (const unsealed of [{ ...report, work: "unknown" }, { ...report, claims: "held" }, { ...report, socket: "failed" }] as const) expect(sealed(unsealed)).toBe(false);
    // Unsealed or another helper's report: decided by observation.
    expect(await attest(self, prior, { by: prior, report: { ...report, work: "unknown" } }, observer({ 150: "there" }))).toMatchObject({ refused: expect.stringContaining("still running") });
    expect(await attest(self, prior, { by: { ...prior, startedAt: 1 }, report }, observer({ 150: "unknown" }))).toMatchObject({ refused: expect.stringContaining("cannot be established") });
    expect(await attest(self, prior, null, observer({ 150: "gone" }))).toEqual({ attestation: { helper: self, exclusive: true, prior: { by: prior, quiescence: "gone" } } });
    expect(await attest(self, prior, null, observer({ 150: "throw" }))).toHaveProperty("refused");
    expect(await attest(self, { ...prior, host: "other" }, null, observer({ 150: "gone" }))).toHaveProperty("refused");
  });

  test("an observation that never answers is unknown within two seconds", async () => {
    const started = Date.now();
    expect(await attest(self, prior, null, observer({ 150: "never" }))).toHaveProperty("refused");
    expect(Date.now() - started).toBeLessThan(2_600);
  });

  test("gone-writer proofs: only this client's prior writers on this host, observed gone, with the exact mark generation", async () => {
    const old: WriterIncarnation = { host: "h", pid: 101, startedAt: 1_700_000_000_000, clientEpoch: 3 };
    const current: WriterIncarnation = { host: "h", pid: 102, startedAt: 1_700_000_200_000, clientEpoch: 4 };
    const owner = (w: WriterIncarnation, clientId = CLIENT) => ({ clientId, writer: w, doc, path: "x", seq: 1, intent: INTENT });
    const hint: RecordHint = {
      activation: self,
      marks: [
        { path: "notes/old.md", gen: 9, owner: owner(old) },
        { path: "notes/live.md", gen: 10, owner: owner(current) },
        { path: "notes/other-client.md", gen: 11, owner: owner(old, "d".repeat(32)) },
        { path: "notes/other-host.md", gen: 12, owner: owner({ ...old, host: "elsewhere", pid: 103 }) },
        { path: "notes/orphan.md", gen: 13, owner: { unknown: "converted" } },
        { path: "notes/unknown.md", gen: 14, owner: owner({ ...old, pid: 104 }) },
      ],
    };
    const seen: number[] = [];
    const proofs = await goneWriterProofs(hint, CLIENT, current, self, observer({ 101: "gone", 102: "gone", 103: "gone", 104: "unknown" }, seen), () => 5);
    expect(proofs).toEqual([{ path: "notes/old.md", writer: old, markGen: 9, checkedAt: 5 }]);
    expect(seen.sort()).toEqual([101, 104]);
  });

  test("process judgement: exact start time is there, only no such process is gone; any other start time or an unreadable one is unknown", () => {
    expect(judge(true, 1_000_000, 1_000_000)).toBe("there");
    expect(judge(true, 1_000_000, 1_001_000)).toBe("unknown");
    // A clock step moves a live process's wall-derived start time by any amount: never proof of reuse (F1).
    for (const actual of [1_010_000, 1_000_000 + 86_400_000, 1, 999_999]) expect(judge(true, 1_000_000, actual)).toBe("unknown");
    expect(judge(false, 1_000_000, null)).toBe("gone");
    expect(judge("unknown", 1_000_000, 1_000_000)).toBe("unknown");
    expect(judge(true, 1_000_000, null)).toBe("unknown");
    expect(parseStartTime("Wed Oct  7 09:15:02 2026\n")).toBe(Date.parse("Wed Oct 7 09:15:02 2026 UTC"));
    expect(parseStartTime("garbage")).toBeNull();
  });

  test("the helper's own incarnation needs a readable start time; an unreadable one is asked again", async () => {
    let answer: number | null = null;
    const read = helperIncarnation({ startTime: async () => answer, observe: async () => "unknown" }, "h", "0.2.0", 321);
    expect(await read()).toBeNull();
    answer = 1_700_000_300_000;
    expect(await read()).toEqual({ host: "h", pid: 321, startedAt: 1_700_000_300_000, helperVersion: "0.2.0" });
    answer = 5;
    expect((await read())!.startedAt).toBe(1_700_000_300_000);
  });
});
