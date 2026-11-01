/**
 * Receipt transitions over a deadline record, pure: each takes the record read under the record lock and
 * returns the next record, the reply and what must be made durable before the reply is sent
 * (engine-receipts.ts runs them inside one record-lock change).
 *
 * Order inside a sequenced receipt is fixed: ledger, activation, stream fence, acknowledgement, duplicate
 * check, order, window, admission (clock, pressure), effect. A duplicate therefore returns its stored
 * immutable reply before any clock, window, pressure, writer or reference check runs. Errors other than a
 * semantic refusal consume no seq and change nothing; a semantic refusal is cached like an applied result.
 *
 * No transition ends a write mark by time, epoch, heartbeat, socket loss or record reset; only the exact
 * flush or abandon of the live write reference, or a supplied gone-process proof for the exact writer and
 * mark generation, does. There is no supersede path.
 */
import { withOldest, type DeadlineRecord, type WriteMark } from "./deadline.ts";
import { own, pathMap } from "./path-map.ts";
import {
  CLOCK_AHEAD_MS, MAX_ACTIVE_WRITES, MAX_DOCS, MAX_EDIT_REFS, MAX_OWNERS, MAX_PROOF, MAX_RECEIPT_CLIENTS, MAX_SEGMENTS, MIN_RECEIPT_TIME, RECEIPT_ENGINE_LEVEL, RECEIPT_LIMITS, REPLY_WINDOW,
  cloneLedger, exactKeys, freeEmptyDocs, freshLedger, hex32, newReceiptId, isDocRef, isHelper, isWriter, ledgerKind, ledgerOf, obj, receiptPath, requestHash, safeInt, sameDoc, sameHelper, sameWriter,
  type ClientStream, type DocRef, type DocState, type HelperIncarnation, type ReceiptLedger, type ReceiptLimits, type ReceiptResult, type RefusalCode, type Segment, type SeqMethod, type WriterIncarnation,
} from "./receipt-ledger.ts";

export interface ReceiptSession {
  helper: HelperIncarnation;
  clientId: string;
  clientEpoch: number;
  /** This client process's writer identity; null when it has none (it then never starts a non-atomic write). */
  writer: WriterIncarnation | null;
  /** Identities returned by this session's openStream; null before it. */
  recordId: string | null;
  streamId: string | null;
}

/** Supplied by the helper (E2); E1 checks only its shape and consistency with the recorded activation. */
export interface ActivationAttestation {
  helper: HelperIncarnation;
  exclusive: true;
  prior: null | { by: HelperIncarnation; quiescence: "gone" | "handover" };
}

export interface OpenStreamRequest {
  id: number;
  method: "openStream";
  vault: string;
  knownRecordId: string | null;
  knownStreamId: string | null;
  nextSeq: number;
  ackedThrough: number;
}

interface Seqd { id: number; vault: string; seq: number; ackedThrough: number }
export type SeqRequest =
  | (Seqd & { method: "noteEdit"; path: string; doc: DocRef; throughGen: number; at: number })
  | (Seqd & { method: "noteWriteStart"; path: string; doc: DocRef; gen: number; intent: string; writer: WriterIncarnation; at: number })
  | (Seqd & { method: "noteFlush"; path: string; doc: DocRef; gen: number; intent: string; editRef: number; writeRef: number | null; blobOid: string })
  | (Seqd & { method: "noteWriteAbandon"; path: string; doc: DocRef; gen: number; intent: string; writeRef: number })
  | (Seqd & { method: "adopt"; path: string; from: DocRef; to: DocRef });

export type ReceiptErrorCode =
  | "bad-request" | "stream-required" | "superseded" | "activation-refused" | "unsupported-ledger" | "busy" | "ack-ahead" | "out-of-order"
  | "window-full" | "clock-ahead" | "pressure" | "ledger-full" | "retired" | "conflict" | "outcome-unknown" | "internal";

export interface StreamIdentity { recordId: string; streamId: string; base: number; appliedThrough: number; ackedThrough: number }

/** No seq consumed and nothing stored, except `outcome-unknown` (maybe applied: resend the identical body). */
export interface ReceiptError {
  error: ReceiptErrorCode;
  message: string;
  /** Authoritative identities and counters when a retained stream did not match the caller's. */
  stream?: StreamIdentity;
}

export interface ListView<T> { count: number; items: T[]; omitted: number }

export interface OpenStreamResult {
  recordId: string;
  streamId: string;
  rebased: boolean;
  objectFormat: "sha1" | "sha256";
  base: number;
  appliedThrough: number;
  ackedThrough: number;
  window: number;
  limits: ReceiptLimits;
  owners: ListView<{ owner: string; epoch: number; docs: number; activeWrites: number }>;
}

/** "full": a new reply or effect; "ack-only": a cached reply with an acknowledgement advance; "none": nothing to write (a cached reply still needs the durability barrier). */
export type PersistKind = "full" | "ack-only" | "none";

export interface GoneWriterProof {
  path: string;
  writer: WriterIncarnation;
  markGen: number;
  checkedAt: number;
}

export const isReceiptError = (x: unknown): x is ReceiptError => obj(x) && typeof x.error === "string";
const fail = (error: ReceiptErrorCode, message: string, extra: Partial<ReceiptError> = {}): ReceiptError => ({ error, message, ...extra });

// ---------------------------------------------------------------------------------------------------
// Static validation (before any record access).

const SEQD = ["id", "method", "vault", "seq", "ackedThrough"];
const BODY_KEYS: Record<SeqMethod, readonly string[]> = {
  noteEdit: [...SEQD, "path", "doc", "throughGen", "at"],
  noteWriteStart: [...SEQD, "path", "doc", "gen", "intent", "writer", "at"],
  noteFlush: [...SEQD, "path", "doc", "gen", "intent", "editRef", "writeRef", "blobOid"],
  noteWriteAbandon: [...SEQD, "path", "doc", "gen", "intent", "writeRef"],
  adopt: [...SEQD, "path", "from", "to"],
};
const vaultName = (x: unknown) => typeof x === "string" && x.length > 0 && x.length <= 256;
const receiptTime = (x: unknown) => safeInt(x, MIN_RECEIPT_TIME);

export function checkSession(x: unknown): x is ReceiptSession {
  return obj(x) && exactKeys(x, ["helper", "clientId", "clientEpoch", "writer", "recordId", "streamId"]) && isHelper(x.helper) && hex32(x.clientId) && safeInt(x.clientEpoch, 1)
    && (x.writer === null || isWriter(x.writer)) && (x.recordId === null || hex32(x.recordId)) && (x.streamId === null || hex32(x.streamId));
}

function checkAttestation(x: unknown): x is ActivationAttestation {
  if (!obj(x) || !exactKeys(x, ["helper", "exclusive", "prior"]) || !isHelper(x.helper) || x.exclusive !== true) return false;
  const p = x.prior;
  return p === null || (obj(p) && exactKeys(p, ["by", "quiescence"]) && isHelper(p.by) && (p.quiescence === "gone" || p.quiescence === "handover"));
}

/** Strict key set and field shapes; writer fields are checked for shape only (equality is an admission check after dedup). */
export function checkSeqRequest(x: unknown, objectFormat: "sha1" | "sha256"): x is SeqRequest {
  if (!obj(x) || typeof x.method !== "string" || !Object.prototype.hasOwnProperty.call(BODY_KEYS, x.method)) return false;
  const method = x.method as SeqMethod;
  if (!exactKeys(x, BODY_KEYS[method]) || !safeInt(x.id) || !vaultName(x.vault) || !safeInt(x.seq, 1) || !safeInt(x.ackedThrough) || !receiptPath(x.path)) return false;
  const blob = (b: unknown) => typeof b === "string" && (objectFormat === "sha1" ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/).test(b);
  switch (method) {
    case "noteEdit": return isDocRef(x.doc) && safeInt(x.throughGen) && receiptTime(x.at);
    case "noteWriteStart": return isDocRef(x.doc) && safeInt(x.gen) && hex32(x.intent) && isWriter(x.writer) && receiptTime(x.at);
    case "noteFlush": return isDocRef(x.doc) && safeInt(x.gen) && hex32(x.intent) && safeInt(x.editRef, 1) && (x.writeRef === null || safeInt(x.writeRef, 1)) && blob(x.blobOid);
    case "noteWriteAbandon": return isDocRef(x.doc) && safeInt(x.gen) && hex32(x.intent) && safeInt(x.writeRef, 1);
    case "adopt": return isDocRef(x.from) && isDocRef(x.to);
  }
}

export function checkOpenStreamRequest(x: unknown): x is OpenStreamRequest {
  return obj(x) && exactKeys(x, ["id", "method", "vault", "knownRecordId", "knownStreamId", "nextSeq", "ackedThrough"]) && x.method === "openStream" && safeInt(x.id) && vaultName(x.vault)
    && (x.knownRecordId === null || hex32(x.knownRecordId)) && (x.knownStreamId === null || hex32(x.knownStreamId)) && safeInt(x.nextSeq, 1) && safeInt(x.ackedThrough);
}

export function checkGoneProofs(x: unknown): x is GoneWriterProof[] {
  return Array.isArray(x) && x.every((p) => obj(p) && exactKeys(p, ["path", "writer", "markGen", "checkedAt"]) && receiptPath(p.path) && isWriter(p.writer) && safeInt(p.markGen, 1) && safeInt(p.checkedAt));
}

// ---------------------------------------------------------------------------------------------------
// Shared helpers.

const identity = (ledger: ReceiptLedger, s: ClientStream): StreamIdentity => ({ recordId: ledger.recordId, streamId: s.streamId, base: s.base, appliedThrough: s.appliedThrough, ackedThrough: s.ackedThrough });

/** Advances the acknowledgement watermark (never lowers it) and retires the cached replies it covers. */
function acknowledge(stream: ClientStream, acked: number): void {
  stream.ackedThrough = acked;
  stream.replies = stream.replies.filter((r) => r.seq > acked);
}

const findDoc = (stream: ClientStream, doc: DocRef, path: string) => stream.docs.find((d) => d.path === path && sameDoc(d.doc, doc));
const activeWrites = (stream: ClientStream) => stream.docs.filter((d) => d.write !== null).length;
const isTagged = (m: WriteMark | undefined, clientId: string) => !!m?.owner && !("unknown" in m.owner) && m.owner.clientId === clientId;

/** Equal throughGen merges (earliest age, newest ticket); over the cap the two lowest merge upward, so a flush must cover the higher gen. */
function insertSegment(segments: Segment[], seg: Segment): void {
  const same = segments.find((s) => s.throughGen === seg.throughGen);
  if (same) {
    same.at = Math.min(same.at, seg.at);
    same.ticket = Math.max(same.ticket, seg.ticket);
  } else {
    segments.push({ ...seg });
    segments.sort((a, b) => a.throughGen - b.throughGen);
  }
  while (segments.length > MAX_SEGMENTS) {
    const [a, b] = segments as [Segment, Segment];
    segments.splice(0, 2, { throughGen: b.throughGen, at: Math.min(a.at, b.at), ticket: Math.max(a.ticket, b.ticket) });
  }
}

function newDoc(doc: DocRef, path: string): DocState {
  return { doc: { ...doc }, path, segments: [], editRefs: [], write: null, flushed: null };
}

// ---------------------------------------------------------------------------------------------------
// openStream (not sequenced).

/**
 * Activation and stream negotiation. An absent client stream is created at `nextSeq - 1` for base, applied
 * and acknowledged together (the old stream's acknowledgement is ignored) and reported as rebased. A retained
 * stream is never reset: mismatching identities return them with its counters and change nothing.
 */
export function openStream(record: DeadlineRecord, session: ReceiptSession, attestation: unknown, req: OpenStreamRequest, now: number, objectFormat: "sha1" | "sha256"): { record: DeadlineRecord; reply: OpenStreamResult | ReceiptError; persist: boolean } {
  const none = (e: ReceiptError) => ({ record, reply: e, persist: false });
  if (ledgerKind(record.receipts) === "unsupported") return none(fail("unsupported-ledger", "this checkout's receipt ledger was written by a newer engine"));
  if (!checkAttestation(attestation) || !sameHelper(attestation.helper, session.helper)) return none(fail("activation-refused", "receipts need an exclusive activation attestation from this helper"));
  const ledger = ledgerOf(record) ? cloneLedger(ledgerOf(record)!) : freshLedger(null, { resets: 0, proofEvicted: 0 });
  const active = ledger.activation;
  if (active === null) {
    if (attestation.prior !== null) return none(fail("activation-refused", "no helper is activated here, so there is no prior helper to hand over from"));
    ledger.activation = { level: RECEIPT_ENGINE_LEVEL, by: { ...attestation.helper }, at: now, handovers: 0 };
  } else if (!sameHelper(active.by, attestation.helper)) {
    if (!attestation.prior || !sameHelper(attestation.prior.by, active.by)) return none(fail("activation-refused", "another helper holds receipt activation for this checkout"));
    ledger.activation = { level: RECEIPT_ENGINE_LEVEL, by: { ...attestation.helper }, at: now, handovers: active.handovers + 1 };
  }

  let stream = ledger.clients[session.clientId];
  let rebased = false;
  if (!stream) {
    const ids = Object.keys(ledger.clients);
    if (ids.length >= MAX_RECEIPT_CLIENTS) {
      // Only a client with nothing outstanding can be dropped; least recently seen first.
      const evictable = ids
        .filter((id) => {
          const s = ledger.clients[id]!;
          return s.docs.length === 0 && s.ackedThrough === s.appliedThrough && !Object.values(record.writes).some((m) => m.active && isTagged(m, id));
        })
        .sort((a, b) => ledger.clients[a]!.lastSeenAt - ledger.clients[b]!.lastSeenAt);
      if (evictable.length === 0) return none(fail("ledger-full", "every receipt client slot holds outstanding work"));
      delete ledger.clients[evictable[0]!];
    }
    const start = req.nextSeq - 1;
    stream = { streamId: newReceiptId(), epochHighWater: session.clientEpoch, base: start, appliedThrough: start, ackedThrough: start, lastSeenAt: now, owners: {}, replies: [], docs: [], proof: [], verified: [] };
    ledger.clients[session.clientId] = stream;
    rebased = true;
  } else {
    if (req.knownRecordId !== ledger.recordId || req.knownStreamId !== stream.streamId) {
      return none(fail("stream-required", "this client's stream is retained under other identities; rejoin it with these", { stream: identity(ledger, stream) }));
    }
    if (session.clientEpoch < stream.epochHighWater) return none(fail("superseded", "a newer process of this client has opened the stream"));
    if (req.ackedThrough > stream.appliedThrough) return none(fail("ack-ahead", "acknowledged beyond the last applied receipt", { stream: identity(ledger, stream) }));
    acknowledge(stream, Math.max(stream.ackedThrough, req.ackedThrough));
    stream.epochHighWater = session.clientEpoch;
    stream.lastSeenAt = now;
  }
  const owners = Object.entries(stream.owners).map(([owner, { epoch }]) => ({
    owner, epoch,
    docs: stream.docs.filter((d) => d.doc.owner === owner).length,
    activeWrites: stream.docs.filter((d) => d.doc.owner === owner && d.write !== null).length,
  }));
  const reply: OpenStreamResult = {
    recordId: ledger.recordId, streamId: stream.streamId, rebased, objectFormat,
    base: stream.base, appliedThrough: stream.appliedThrough, ackedThrough: stream.ackedThrough,
    window: REPLY_WINDOW, limits: { ...RECEIPT_LIMITS },
    owners: { count: owners.length, items: owners, omitted: 0 },
  };
  return { record: withOldest({ ...record, receipts: ledger }), reply, persist: true };
}

// ---------------------------------------------------------------------------------------------------
// Sequenced receipts.

interface Draft {
  generation: number;
  writes: Record<string, WriteMark>;
  pendingSince: Record<string, number>;
  latestEditNoted: number | null;
}

type Body =
  | { ok: "edit"; ticket: number; retiredRefs: number[] }
  | { ok: "write-started"; token: number }
  | { ok: "flushed"; ackGen: number; endedWrite: boolean }
  | { ok: "write-abandoned" }
  | { ok: "adopted"; segments: number }
  | { refused: RefusalCode };

const refuse = (refused: RefusalCode): Body => ({ refused });

/** The owner binding a request's document must match: its immutable origin epoch, never the applying session's. */
function ownerCheck(stream: ClientStream, session: ReceiptSession, doc: DocRef): "new" | "bound" | "mismatch" {
  if (doc.ownerEpoch < 1 || doc.ownerEpoch > session.clientEpoch) return "mismatch";
  const bound = stream.owners[doc.owner];
  if (!bound) return "new";
  return bound.epoch === doc.ownerEpoch ? "bound" : "mismatch";
}

/** The live write reference and its tagged mark, when both still name exactly this write. */
function liveWrite(row: DocState | undefined, draft: Draft, clientId: string, path: string, writeRef: number, gen: number, intent: string): WriteMark | null {
  const w = row?.write;
  const mark = own(draft.writes, path);
  if (!w || w.seq !== writeRef || w.gen !== gen || w.intent !== intent) return null;
  if (!mark?.active || !mark.owner || "unknown" in mark.owner || mark.owner.clientId !== clientId || mark.owner.seq !== writeRef || mark.gen !== w.token) return null;
  return mark;
}

function effect(req: SeqRequest, at: number, stream: ClientStream, ledger: ReceiptLedger, draft: Draft, session: ReceiptSession): Body {
  const clientId = session.clientId;
  if (req.method === "adopt") {
    const from = ownerCheck(stream, session, req.from);
    const to = ownerCheck(stream, session, req.to);
    if (from === "mismatch" || to === "mismatch") return refuse("owner-mismatch");
    if (from === "new" || to === "new" || req.to.ownerEpoch !== session.clientEpoch || req.from.ownerEpoch >= req.to.ownerEpoch || sameDoc(req.from, req.to)) return refuse("adopt-invalid");
    const source = findDoc(stream, req.from, req.path);
    const target = findDoc(stream, req.to, req.path);
    if (!source || !target) return refuse("adopt-invalid");
    const moved = source.segments.length;
    for (const s of source.segments) insertSegment(target.segments, s);
    source.segments = [];
    source.editRefs = [];
    return { ok: "adopted", segments: moved };
  }

  const owner = ownerCheck(stream, session, req.doc);
  if (owner === "mismatch") return refuse("owner-mismatch");
  const row = findDoc(stream, req.doc, req.path);

  switch (req.method) {
    case "noteEdit": {
      const ticket = draft.generation + 1;
      draft.generation = ticket;
      stream.owners[req.doc.owner] ??= { epoch: req.doc.ownerEpoch };
      const target = row ?? newDoc(req.doc, req.path);
      if (!row) stream.docs.push(target);
      insertSegment(target.segments, { throughGen: req.throughGen, at, ticket });
      // Retire an existing reference before inserting, so the reference returned now always survives.
      const retiredRefs: number[] = [];
      while (target.editRefs.length >= MAX_EDIT_REFS) {
        const oldest = target.editRefs.reduce((a, b) => (b.seq < a.seq ? b : a));
        target.editRefs = target.editRefs.filter((r) => r !== oldest);
        retiredRefs.push(oldest.seq);
      }
      target.editRefs.push({ seq: req.seq, throughGen: req.throughGen, ticket });
      draft.latestEditNoted = draft.latestEditNoted === null ? at : Math.max(draft.latestEditNoted, at);
      return { ok: "edit", ticket, retiredRefs };
    }
    case "noteWriteStart": {
      if (!session.writer || !sameWriter(req.writer, session.writer)) return refuse("stale-writer");
      if (own(draft.writes, req.path)?.active || row?.write) return refuse("write-active");
      const token = draft.generation + 1;
      draft.generation = token;
      stream.owners[req.doc.owner] ??= { epoch: req.doc.ownerEpoch };
      const target = row ?? newDoc(req.doc, req.path);
      if (!row) stream.docs.push(target);
      draft.writes[req.path] = { gen: token, active: true, since: at, owner: { clientId, writer: { ...req.writer }, doc: { ...req.doc }, path: req.path, seq: req.seq, intent: req.intent } };
      target.write = { seq: req.seq, gen: req.gen, intent: req.intent, token };
      return { ok: "write-started", token };
    }
    case "noteFlush": {
      if (owner === "new" || !row) return refuse("ref-invalid");
      const ref = row.editRefs.find((r) => r.seq === req.editRef);
      if (!ref) return refuse("ref-invalid");
      if (ref.throughGen !== req.gen) return refuse("gen-mismatch");
      let mark: WriteMark | null = null;
      if (req.writeRef !== null) {
        mark = liveWrite(row, draft, clientId, req.path, req.writeRef, req.gen, req.intent);
        if (!mark) return refuse("ref-invalid");
      }
      const gen = req.gen;
      const ages = row.segments.filter((s) => s.throughGen <= gen).map((s) => s.at);
      if (mark) ages.push(mark.since);
      if (row.flushed) ages.push(row.flushed.from);
      // Nothing covered (older bytes below coalesced newer segments): the earliest remaining segment is a
      // conservative age; those segments stay owed.
      if (ages.length === 0) for (const s of row.segments) ages.push(s.at);
      if (ages.length === 0 || !ages.every(Number.isFinite)) return refuse("ref-invalid");
      const from = Math.min(...ages);
      const ackGen = draft.generation + 1;
      draft.generation = ackGen;
      row.segments = row.segments.filter((s) => s.throughGen > gen);
      row.editRefs = row.editRefs.filter((r) => r.throughGen > gen);
      if (!row.flushed || row.flushed.gen <= gen) row.flushed = { gen, blobOid: req.blobOid, from, ackGen, seq: req.seq };
      else row.flushed.from = Math.min(row.flushed.from, from);
      if (mark) {
        draft.writes[req.path] = { gen: ackGen, active: false, since: mark.since };
        row.write = null;
      }
      const at0 = stream.proof.findIndex((p) => p.path === req.path && sameDoc(p.doc, req.doc));
      if (at0 < 0 || stream.proof[at0]!.gen <= gen) {
        if (at0 >= 0) stream.proof.splice(at0, 1);
        stream.proof.push({ doc: { ...req.doc }, path: req.path, gen, blobOid: req.blobOid, ackGen, flushSeq: req.seq, state: "registered", snapshotSeq: null, snapshot: null });
        while (stream.proof.length > MAX_PROOF) {
          let oldest = 0;
          for (let i = 1; i < stream.proof.length; i++) if (stream.proof[i]!.ackGen < stream.proof[oldest]!.ackGen) oldest = i;
          stream.proof.splice(oldest, 1);
          ledger.counters.proofEvicted += 1;
        }
      }
      return { ok: "flushed", ackGen, endedWrite: mark !== null };
    }
    case "noteWriteAbandon": {
      if (owner === "new" || !row) return refuse("ref-invalid");
      const mark = liveWrite(row, draft, clientId, req.path, req.writeRef, req.gen, req.intent);
      if (!mark) return refuse("ref-invalid");
      endMark(draft, req.path, mark);
      row.write = null;
      return { ok: "write-abandoned" };
    }
  }
}

/** Ends a mark whose writer never opened, or closed, the destination: capture must read the path again; its age is kept. */
function endMark(draft: Draft, path: string, mark: WriteMark): void {
  draft.generation += 1;
  draft.writes[path] = { gen: draft.generation, active: false, since: mark.since };
  const pending = own(draft.pendingSince, path);
  draft.pendingSince[path] = pending === undefined ? mark.since : Math.min(pending, mark.since);
}

/** Admission for a genuinely new seq: would it create a document row, owner or active write beyond the bounds? */
function underPressure(req: SeqRequest, stream: ClientStream, session: ReceiptSession): boolean {
  if (req.method !== "noteEdit" && req.method !== "noteWriteStart") return false;
  if (ownerCheck(stream, session, req.doc) === "new" && Object.keys(stream.owners).length >= MAX_OWNERS) return true;
  if (!findDoc(stream, req.doc, req.path) && stream.docs.length >= MAX_DOCS) return true;
  return req.method === "noteWriteStart" && activeWrites(stream) >= MAX_ACTIVE_WRITES;
}

export function applyReceipt(record: DeadlineRecord, session: ReceiptSession, req: SeqRequest, now: number): { record: DeadlineRecord; reply: ReceiptResult | ReceiptError; persistKind: PersistKind } {
  const none = (e: ReceiptError) => ({ record, reply: e, persistKind: "none" as const });
  if (ledgerKind(record.receipts) === "unsupported") return none(fail("unsupported-ledger", "this checkout's receipt ledger was written by a newer engine"));
  const current = ledgerOf(record);
  if (!current) return none(fail("stream-required", "no receipt stream exists for this checkout; open one first"));
  if (!current.activation || !sameHelper(current.activation.by, session.helper)) return none(fail("activation-refused", "this helper does not hold receipt activation for this checkout"));
  const stored = current.clients[session.clientId];
  if (!stored || current.recordId !== session.recordId || stored.streamId !== session.streamId) {
    return none(fail("stream-required", "the receipt stream changed; open it again", stored ? { stream: identity(current, stored) } : {}));
  }
  if (session.clientEpoch < stored.epochHighWater) return none(fail("superseded", "a newer process of this client has opened the stream"));
  if (req.ackedThrough > stored.appliedThrough) return none(fail("ack-ahead", "acknowledged beyond the last applied receipt"));
  const acked = Math.max(stored.ackedThrough, req.ackedThrough);
  if (req.seq <= acked) return none(fail("retired", "this seq was acknowledged and its reply retired"));
  const hash = requestHash(req as unknown as SeqRequest & Record<string, unknown>);
  if (req.seq <= stored.appliedThrough) {
    const entry = stored.replies.find((r) => r.seq === req.seq)!;
    if (entry.hash !== hash) return none(fail("conflict", "this seq was applied with a different body"));
    if (acked === stored.ackedThrough) return { record, reply: entry.result, persistKind: "none" };
    const ledger = cloneLedger(current);
    acknowledge(ledger.clients[session.clientId]!, acked);
    return { record: { ...record, receipts: ledger }, reply: entry.result, persistKind: "ack-only" };
  }
  if (req.seq > stored.appliedThrough + 1) return none(fail("out-of-order", "a receipt before this seq has not been applied"));
  if (stored.appliedThrough - acked >= REPLY_WINDOW) return none(fail("window-full", "acknowledge earlier replies before sending more"));
  let at = 0;
  if (req.method === "noteEdit" || req.method === "noteWriteStart") {
    if (req.at > now + CLOCK_AHEAD_MS) return none(fail("clock-ahead", "the receipt is dated more than a day ahead of this computer's clock"));
    at = Math.min(req.at, now);
  }
  if (underPressure(req, stored, session)) return none(fail("pressure", "the receipt ledger is at its bound for documents, owners or active writes"));

  const ledger = cloneLedger(current);
  const stream = ledger.clients[session.clientId]!;
  acknowledge(stream, acked);
  const draft: Draft = { generation: record.generation, writes: pathMap(record.writes), pendingSince: pathMap(record.pendingSince), latestEditNoted: record.latestEditNoted };
  const body = effect(req, at, stream, ledger, draft, session);
  // A semantic refusal changes no document state: only its cached reply is stored.
  const changed = !("refused" in body);
  const result = { seq: req.seq, recordId: ledger.recordId, durable: true as const, epoch: session.clientEpoch, ...body } as ReceiptResult;
  stream.replies.push({ seq: req.seq, hash, method: req.method, result });
  stream.appliedThrough = req.seq;
  stream.lastSeenAt = now;
  freeEmptyDocs(stream);
  const next: DeadlineRecord = changed
    ? { ...record, generation: draft.generation, writes: draft.writes, pendingSince: draft.pendingSince, latestEditNoted: draft.latestEditNoted, receipts: ledger }
    : { ...record, receipts: ledger };
  return { record: withOldest(next), reply: result, persistKind: "full" };
}

/**
 * Ends tagged marks whose exact writer process the helper found gone (never unknown or running). Applies
 * only where the mark is still active at `markGen`, is tagged with that writer, and the writer ran on the
 * helper's host. Unknown-owner marks are never released here.
 */
export function releaseGoneWriters(record: DeadlineRecord, proofs: readonly GoneWriterProof[], helperHost: string): { record: DeadlineRecord; released: string[] } {
  const current = ledgerOf(record);
  if (!current) return { record, released: [] };
  const ledger = cloneLedger(current);
  const draft: Draft = { generation: record.generation, writes: pathMap(record.writes), pendingSince: pathMap(record.pendingSince), latestEditNoted: record.latestEditNoted };
  const released: string[] = [];
  for (const proof of proofs) {
    const mark = own(draft.writes, proof.path);
    const owner = mark?.owner;
    if (!mark?.active || mark.gen !== proof.markGen || !owner || "unknown" in owner) continue;
    if (!sameWriter(owner.writer, proof.writer) || owner.writer.host !== helperHost) continue;
    endMark(draft, proof.path, mark);
    const stream = ledger.clients[owner.clientId];
    const row = stream ? findDoc(stream, owner.doc, proof.path) : undefined;
    if (stream && row?.write?.seq === owner.seq) {
      row.write = null;
      freeEmptyDocs(stream);
    }
    released.push(proof.path);
  }
  if (released.length === 0) return { record, released };
  return { record: withOldest({ ...record, generation: draft.generation, writes: draft.writes, pendingSince: draft.pendingSince, receipts: ledger }), released };
}
