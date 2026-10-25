/**
 * Receipt status: one read-only view computed from one record read under the record lock. Counts and
 * oldest times come from the whole record before any list is shortened; only list items are cut, and
 * `omitted` says exactly how many. Other clients contribute counts and times only, never paths. A view
 * whose required rows are omitted, or with any positive count, cannot support a covered claim; that
 * decision belongs to the client.
 */
import type { DeadlineRecord } from "./deadline.ts";
import { own } from "./path-map.ts";
import { MAX_WANT, RECEIPT_LIMITS, exactKeys, isDocRef, ledgerKind, ledgerOf, obj, receiptPath, sameDoc, type DocRef, type HelperIncarnation, type ProofRow, type ReceiptLimits } from "./receipt-ledger.ts";
import type { ListView, ReceiptError, ReceiptSession } from "./receipt-transitions.ts";

export interface Agg { count: number; oldestAt: number | null }

export interface DocProofView {
  path: string;
  doc: DocRef;
  state: "none" | "debt" | "registered" | "captured" | "mismatch" | "verified";
  /** Highest throughGen still unflushed. */
  unflushedThroughGen: number | null;
  flushed: { gen: number; blobOid: string; ackGen: number } | null;
  proof: { gen: number; blobOid: string; state: ProofRow["state"]; snapshotSeq: number | null } | null;
  verified: { gen: number; blobOid: string; snapshot: string; snapshotSeq: number; at: number } | null;
  activeWrite: boolean;
}

export interface ReceiptStatusView {
  recordId: string;
  observedGeneration: number;
  observedAt: number;
  activation: { by: HelperIncarnation; at: number; handovers: number } | null;
  captureQuarantine: { since: number; reason: string } | null;
  stream: { clientId: string; streamId: string; epochHighWater: number; sessionEpoch: number; base: number; appliedThrough: number; ackedThrough: number; replies: number; docs: number; limits: ReceiptLimits };
  vault: {
    /** Whole record, receipt debt included. */
    oldestUnprotectedEdit: number | null;
    legacyVaultWide: Agg;
    legacyPerPath: Agg;
    capturedUnverified: Agg;
    pending: Agg;
    unlisted: Agg;
    activeWrites: { untagged: Agg; thisClient: Agg; otherClient: Agg; unknownOwner: Agg };
    otherClientDebt: Agg & { clients: number };
    captureQuarantine: { since: number; reason: "incomplete-guards" } | null;
    resetFloor: { from: number; reason: string } | null;
    counters: { resets: number; proofEvicted: number };
  };
  thisClient: {
    unflushed: Agg;
    blobDebt: Agg;
    activeWrites: Agg;
    owners: ListView<{ owner: string; epoch: number; unflushed: Agg; blobDebt: Agg; activeWrites: number }>;
  };
  /** Exactly the requested documents, in request order; never other clients' rows. */
  docs: ListView<DocProofView>;
}

export interface WantedDoc { path: string; doc: DocRef }

export function checkWant(x: unknown): x is WantedDoc[] {
  return Array.isArray(x) && x.length <= MAX_WANT && x.every((w) => obj(w) && exactKeys(w, ["path", "doc"]) && receiptPath(w.path) && isDocRef(w.doc));
}

function agg(): Agg { return { count: 0, oldestAt: null }; }
function add(a: Agg, t: number): void {
  a.count += 1;
  a.oldestAt = a.oldestAt === null ? t : Math.min(a.oldestAt, t);
}
function list<T>(items: T[], maxItems: number): ListView<T> {
  const kept = items.slice(0, Math.max(0, maxItems));
  return { count: items.length, items: kept, omitted: items.length - kept.length };
}

export function receiptStatusView(record: DeadlineRecord, session: ReceiptSession, want: readonly WantedDoc[], maxItems: number, observedAt: number): ReceiptStatusView | ReceiptError {
  if (ledgerKind(record.receipts) === "unsupported") return { error: "unsupported-ledger", message: "this checkout's receipt ledger was written by a newer engine" };
  const ledger = ledgerOf(record);
  const stream = ledger?.clients[session.clientId];
  if (!ledger || !stream) return { error: "stream-required", message: "no receipt stream exists for this client; open one first" };

  const legacyVaultWide = agg();
  const legacyPerPath = agg();
  for (const u of record.unflushed) add(u.path === null ? legacyVaultWide : legacyPerPath, u.from);
  for (const f of record.flushed) add(f.path === null ? legacyVaultWide : legacyPerPath, f.from);
  const capturedUnverified = agg();
  for (const c of record.captured) add(capturedUnverified, c.from);
  const pending = agg();
  for (const t of Object.values(record.pendingSince)) add(pending, t);
  const unlisted = agg();
  for (const t of Object.values(record.unlistedSince)) add(unlisted, t);
  const activeWrites = { untagged: agg(), thisClient: agg(), otherClient: agg(), unknownOwner: agg() };
  for (const mark of Object.values(record.writes)) {
    if (!mark.active) continue;
    const owner = mark.owner;
    if (!owner) add(activeWrites.untagged, mark.since);
    else if ("unknown" in owner) add(activeWrites.unknownOwner, mark.since);
    else add(owner.clientId === session.clientId ? activeWrites.thisClient : activeWrites.otherClient, mark.since);
  }
  const otherClientDebt = { ...agg(), clients: 0 };
  for (const [clientId, other] of Object.entries(ledger.clients)) {
    if (clientId === session.clientId) continue;
    const before = otherClientDebt.count;
    for (const d of other.docs) {
      for (const s of d.segments) add(otherClientDebt, s.at);
      if (d.flushed) add(otherClientDebt, d.flushed.from);
    }
    if (otherClientDebt.count > before) otherClientDebt.clients += 1;
  }

  const unflushed = agg();
  const blobDebt = agg();
  const writes = agg();
  const perOwner = new Map<string, { unflushed: Agg; blobDebt: Agg; activeWrites: number }>();
  for (const owner of Object.keys(stream.owners)) perOwner.set(owner, { unflushed: agg(), blobDebt: agg(), activeWrites: 0 });
  for (const d of stream.docs) {
    const o = perOwner.get(d.doc.owner)!;
    for (const s of d.segments) { add(unflushed, s.at); add(o.unflushed, s.at); }
    if (d.flushed) { add(blobDebt, d.flushed.from); add(o.blobDebt, d.flushed.from); }
    if (d.write) {
      o.activeWrites += 1;
      add(writes, own(record.writes, d.path)?.since ?? stream.lastSeenAt);
    }
  }

  const docs = want.map((w): DocProofView => {
    const row = stream.docs.find((d) => d.path === w.path && sameDoc(d.doc, w.doc));
    const proof = stream.proof.find((p) => p.path === w.path && sameDoc(p.doc, w.doc));
    const verified = stream.verified.find((v) => v.path === w.path && sameDoc(v.doc, w.doc));
    const segments = row?.segments ?? [];
    let state: DocProofView["state"] = "none";
    if (segments.length > 0) state = "debt";
    else if (proof) state = proof.state;
    else if (row?.flushed) state = "debt";
    else if (verified) state = "verified";
    return {
      path: w.path,
      doc: { ...w.doc },
      state,
      unflushedThroughGen: segments.length === 0 ? null : Math.max(...segments.map((s) => s.throughGen)),
      flushed: row?.flushed ? { gen: row.flushed.gen, blobOid: row.flushed.blobOid, ackGen: row.flushed.ackGen } : null,
      proof: proof ? { gen: proof.gen, blobOid: proof.blobOid, state: proof.state, snapshotSeq: proof.snapshotSeq } : null,
      verified: verified ? { gen: verified.gen, blobOid: verified.blobOid, snapshot: verified.snapshot, snapshotSeq: verified.snapshotSeq, at: verified.at } : null,
      activeWrite: row?.write !== null && row?.write !== undefined,
    };
  });

  return {
    recordId: ledger.recordId,
    observedGeneration: record.generation,
    observedAt,
    activation: ledger.activation ? { by: { ...ledger.activation.by }, at: ledger.activation.at, handovers: ledger.activation.handovers } : null,
    captureQuarantine: ledger.captureQuarantine ? { ...ledger.captureQuarantine } : null,
    stream: {
      clientId: session.clientId, streamId: stream.streamId, epochHighWater: stream.epochHighWater, sessionEpoch: session.clientEpoch,
      base: stream.base, appliedThrough: stream.appliedThrough, ackedThrough: stream.ackedThrough, replies: stream.replies.length, docs: stream.docs.length, limits: { ...RECEIPT_LIMITS },
    },
    vault: {
      oldestUnprotectedEdit: record.oldestUnprotectedEdit,
      legacyVaultWide, legacyPerPath, capturedUnverified, pending, unlisted, activeWrites, otherClientDebt,
      captureQuarantine: ledger.captureQuarantine ? { ...ledger.captureQuarantine } : null,
      resetFloor: ledger.resetFloor ? { from: ledger.resetFloor.from, reason: ledger.resetFloor.reason } : null,
      counters: { ...ledger.counters },
    },
    thisClient: {
      unflushed, blobDebt, activeWrites: writes,
      owners: list([...perOwner].map(([owner, o]) => ({ owner, epoch: stream.owners[owner]!.epoch, ...o })), maxItems),
    },
    docs: list(docs, maxItems),
  };
}
