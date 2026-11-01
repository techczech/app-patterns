/**
 * Editor receipt ledger: the optional `receipts` field of a schema-3 deadline record (ledger version 2).
 *
 * The ledger lives inside deadline.json, so a receipt's duplicate check, its debt change, its cached reply
 * and the acknowledgement watermark are one durable replacement of one file (receipt-transitions.ts). This
 * module holds the stored shapes, their strict validator, the request hash and the debt terms the deadline
 * arithmetic adds (deadline.ts). Nothing here reads or writes files.
 *
 * Two retention mechanisms are independent: the reply cache holds exactly the seqs between the client's
 * durable acknowledgement and the last applied seq, while live edit/write references stay on their
 * document until a flush, abandon or adoption consumes them. Debt (unflushed segments and blob-bound
 * flushed entries) is never evicted, folded away or dropped; only proof and verified rows are evictable,
 * and each eviction is counted.
 *
 * A ledger with another version number is kept opaque: its bytes are never rewritten (engine-store.ts)
 * and every capture, publication and mutation refuses while it is present.
 */
import { createHash, randomBytes } from "node:crypto";
import type { DeadlineRecord, WriteMark } from "./deadline.ts";
import { own } from "./path-map.ts";

export const RECEIPT_ENGINE_LEVEL = 1;
export const RECEIPT_LEDGER_VERSION = 2;
export const REPLY_WINDOW = 4;
export const MAX_RECEIPT_CLIENTS = 4;
export const MAX_OWNERS = 64;
export const MAX_DOCS = 256;
export const MAX_SEGMENTS = 4;
export const MAX_EDIT_REFS = 4;
export const MAX_ACTIVE_WRITES = 16;
export const MAX_PROOF = 256;
export const MAX_VERIFIED = 256;
export const MAX_WANT = 64;
export const RECEIPT_LOCK_WAIT_MS = 2000;
/** Earliest edit time a receipt may carry (2020-01-01). */
export const MIN_RECEIPT_TIME = 1_577_836_800_000;
/** A new receipt dated further ahead of the engine clock than this is refused as clock-ahead. */
export const CLOCK_AHEAD_MS = 86_400_000;
export const MAX_RECEIPT_PATH_BYTES = 1024;

export interface ReceiptLimits {
  window: number;
  maxClients: number;
  maxOwners: number;
  maxDocs: number;
  maxSegments: number;
  maxEditRefs: number;
  maxActiveWrites: number;
  maxProof: number;
  maxVerified: number;
  maxWant: number;
}

export const RECEIPT_LIMITS: ReceiptLimits = {
  window: REPLY_WINDOW,
  maxClients: MAX_RECEIPT_CLIENTS,
  maxOwners: MAX_OWNERS,
  maxDocs: MAX_DOCS,
  maxSegments: MAX_SEGMENTS,
  maxEditRefs: MAX_EDIT_REFS,
  maxActiveWrites: MAX_ACTIVE_WRITES,
  maxProof: MAX_PROOF,
  maxVerified: MAX_VERIFIED,
  maxWant: MAX_WANT,
};

/** Persistent document identity: renderer epochs and generations compare only within one `owner`. */
export interface DocRef {
  owner: string;
  /** Client epoch under which the owner was first seen; immutable, part of every request hash. */
  ownerEpoch: number;
  docEpoch: number;
}

export interface WriterIncarnation {
  host: string;
  pid: number;
  startedAt: number;
  clientEpoch: number;
}

export interface HelperIncarnation {
  host: string;
  pid: number;
  startedAt: number;
  helperVersion: string;
}

export type TaggedWriteOwner =
  | { clientId: string; writer: WriterIncarnation; doc: DocRef; path: string; seq: number; intent: string }
  | { unknown: "converted" | "damaged-ledger" };

export type RefusalCode = "ref-invalid" | "gen-mismatch" | "write-active" | "stale-writer" | "owner-mismatch" | "adopt-invalid";

type Applied<R> = { seq: number; recordId: string; durable: true; /** Session epoch that applied it. */ epoch: number } & R;
export type ReceiptResult =
  | Applied<{ ok: "edit"; ticket: number; retiredRefs: number[] }>
  | Applied<{ ok: "write-started"; token: number }>
  | Applied<{ ok: "flushed"; ackGen: number; endedWrite: boolean }>
  | Applied<{ ok: "write-abandoned" }>
  | Applied<{ ok: "adopted"; segments: number }>
  | Applied<{ refused: RefusalCode }>;

export type SeqMethod = "noteEdit" | "noteWriteStart" | "noteFlush" | "noteWriteAbandon" | "adopt";

export interface ReplyEntry {
  seq: number;
  hash: string;
  method: SeqMethod;
  result: ReceiptResult;
}

export interface Segment { throughGen: number; at: number; ticket: number }
export interface EditRef { seq: number; throughGen: number; ticket: number }
export interface LiveWrite { seq: number; gen: number; intent: string; token: number }
export interface BlobDebt { gen: number; blobOid: string; from: number; ackGen: number; seq: number }

export interface DocState {
  doc: DocRef;
  path: string;
  /** Unflushed debt, ascending throughGen. */
  segments: Segment[];
  editRefs: EditRef[];
  /** Live write reference; the guard itself is the legacy `writes[path]` mark. */
  write: LiveWrite | null;
  /** Debt bound to the exact saved blob: cleared only by a capture that read that blob. */
  flushed: BlobDebt | null;
}

export interface ProofRow {
  doc: DocRef;
  path: string;
  gen: number;
  blobOid: string;
  ackGen: number;
  flushSeq: number;
  state: "registered" | "captured" | "mismatch";
  snapshotSeq: number | null;
  /** Exact capture commit that read the blob; kept unchanged when the row is verified. */
  snapshot: string | null;
}

export interface VerifiedRow {
  doc: DocRef;
  path: string;
  gen: number;
  blobOid: string;
  snapshot: string;
  snapshotSeq: number;
  at: number;
}

export interface ClientStream {
  streamId: string;
  epochHighWater: number;
  base: number;
  appliedThrough: number;
  ackedThrough: number;
  lastSeenAt: number;
  owners: Record<string, { epoch: number }>;
  /** Exactly the seqs (ackedThrough, appliedThrough], ascending. */
  replies: ReplyEntry[];
  docs: DocState[];
  proof: ProofRow[];
  verified: VerifiedRow[];
}

export interface ReceiptLedger {
  v: 2;
  recordId: string;
  activation: { level: 1; by: HelperIncarnation; at: number; handovers: number } | null;
  captureQuarantine: { since: number; reason: "incomplete-guards" } | null;
  resetFloor: { from: number; reason: "converted" | "damaged-ledger"; at: number } | null;
  counters: { resets: number; proofEvicted: number };
  clients: Record<string, ClientStream>;
}

/** A ledger written by a newer engine: kept byte-for-byte and never interpreted. */
export interface OpaqueLedger {
  v: number;
  [key: string]: unknown;
}

export type LedgerKind = "none" | "v2" | "unsupported" | "damaged";

// ---------------------------------------------------------------------------------------------------
// Shape checks shared by the ledger validator and the request validator.

export const obj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const isFiniteNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
export const safeInt = (x: unknown, min = 0): x is number => Number.isSafeInteger(x) && (x as number) >= min;
export const hex32 = (x: unknown): x is string => typeof x === "string" && /^[0-9a-f]{32}$/.test(x);
const hex = (x: unknown): x is string => typeof x === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(x);
const sha256Hex = (x: unknown): x is string => typeof x === "string" && /^[0-9a-f]{64}$/.test(x);
const shortText = (x: unknown, maxLength: number): x is string => typeof x === "string" && x.length > 0 && x.length <= maxLength;

/** Exactly these keys, no others. */
export function exactKeys(x: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(x);
  return own.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(x, k));
}

/** Worktree-relative POSIX path, the engine's own rule, at most 1024 UTF-8 bytes. */
export function receiptPath(x: unknown): x is string {
  if (typeof x !== "string" || x === "" || x.includes("\0") || x.startsWith("/")) return false;
  if (x.split("/").some((p) => p === "" || p === "." || p === "..")) return false;
  return Buffer.byteLength(x, "utf8") <= MAX_RECEIPT_PATH_BYTES;
}

export function isDocRef(x: unknown): x is DocRef {
  return obj(x) && exactKeys(x, ["owner", "ownerEpoch", "docEpoch"]) && hex32(x.owner) && safeInt(x.ownerEpoch, 1) && safeInt(x.docEpoch, 0);
}

export function isWriter(x: unknown): x is WriterIncarnation {
  return obj(x) && exactKeys(x, ["host", "pid", "startedAt", "clientEpoch"]) && shortText(x.host, 255) && safeInt(x.pid, 1) && safeInt(x.startedAt, 0) && safeInt(x.clientEpoch, 1);
}

export function isHelper(x: unknown): x is HelperIncarnation {
  return obj(x) && exactKeys(x, ["host", "pid", "startedAt", "helperVersion"]) && shortText(x.host, 255) && safeInt(x.pid, 1) && safeInt(x.startedAt, 0) && shortText(x.helperVersion, 64);
}

export const sameDoc = (a: DocRef, b: DocRef) => a.owner === b.owner && a.ownerEpoch === b.ownerEpoch && a.docEpoch === b.docEpoch;
export const sameWriter = (a: WriterIncarnation, b: WriterIncarnation) => a.host === b.host && a.pid === b.pid && a.startedAt === b.startedAt && a.clientEpoch === b.clientEpoch;
export const sameHelper = (a: HelperIncarnation, b: HelperIncarnation) => a.host === b.host && a.pid === b.pid && a.startedAt === b.startedAt && a.helperVersion === b.helperVersion;

export function isTaggedOwner(x: unknown): x is TaggedWriteOwner {
  if (!obj(x)) return false;
  if ("unknown" in x) return exactKeys(x, ["unknown"]) && (x.unknown === "converted" || x.unknown === "damaged-ledger");
  return exactKeys(x, ["clientId", "writer", "doc", "path", "seq", "intent"]) && hex32(x.clientId) && isWriter(x.writer) && isDocRef(x.doc) && receiptPath(x.path) && safeInt(x.seq, 1) && hex32(x.intent);
}

// ---------------------------------------------------------------------------------------------------
// Strict validation of a stored ledger.

const SEQ_METHODS: readonly SeqMethod[] = ["noteEdit", "noteWriteStart", "noteFlush", "noteWriteAbandon", "adopt"];
const REFUSALS: readonly RefusalCode[] = ["ref-invalid", "gen-mismatch", "write-active", "stale-writer", "owner-mismatch", "adopt-invalid"];
const APPLIED_KEYS = ["seq", "recordId", "durable", "epoch"];

function isResult(x: unknown, seq: number, recordId: string, highWater: number, generation: number): boolean {
  if (!obj(x) || x.seq !== seq || x.recordId !== recordId || x.durable !== true || !safeInt(x.epoch, 1) || x.epoch > highWater) return false;
  if ("refused" in x) return exactKeys(x, [...APPLIED_KEYS, "refused"]) && REFUSALS.includes(x.refused as RefusalCode);
  const gen = (g: unknown) => safeInt(g, 1) && g <= generation;
  switch (x.ok) {
    case "edit": return exactKeys(x, [...APPLIED_KEYS, "ok", "ticket", "retiredRefs"]) && gen(x.ticket) && Array.isArray(x.retiredRefs) && x.retiredRefs.every((r) => safeInt(r, 1));
    case "write-started": return exactKeys(x, [...APPLIED_KEYS, "ok", "token"]) && gen(x.token);
    case "flushed": return exactKeys(x, [...APPLIED_KEYS, "ok", "ackGen", "endedWrite"]) && gen(x.ackGen) && typeof x.endedWrite === "boolean";
    case "write-abandoned": return exactKeys(x, [...APPLIED_KEYS, "ok"]);
    case "adopted": return exactKeys(x, [...APPLIED_KEYS, "ok", "segments"]) && safeInt(x.segments, 0);
    default: return false;
  }
}

function isClientStream(clientId: string, x: unknown, ledger: { recordId: string }, generation: number, writes: Record<string, WriteMark>): x is ClientStream {
  if (!obj(x) || !exactKeys(x, ["streamId", "epochHighWater", "base", "appliedThrough", "ackedThrough", "lastSeenAt", "owners", "replies", "docs", "proof", "verified"])) return false;
  if (!hex32(x.streamId) || !safeInt(x.epochHighWater, 1) || !safeInt(x.base) || !safeInt(x.appliedThrough) || !safeInt(x.ackedThrough) || !isFiniteNum(x.lastSeenAt)) return false;
  const high = x.epochHighWater;
  const applied = x.appliedThrough;
  if (!(x.base <= x.ackedThrough && x.ackedThrough <= applied)) return false;
  if (!obj(x.owners) || Object.keys(x.owners).length > MAX_OWNERS) return false;
  for (const [owner, binding] of Object.entries(x.owners)) {
    if (!hex32(owner) || !obj(binding) || !exactKeys(binding, ["epoch"]) || !safeInt(binding.epoch, 1) || binding.epoch > high) return false;
  }
  const owners = x.owners as Record<string, { epoch: number }>;
  const bound = (d: DocRef) => owners[d.owner]?.epoch === d.ownerEpoch;
  if (!Array.isArray(x.replies) || x.replies.length !== applied - x.ackedThrough || x.replies.length > REPLY_WINDOW) return false;
  for (let i = 0; i < x.replies.length; i++) {
    const r = x.replies[i];
    const seq = x.ackedThrough + 1 + i;
    if (!obj(r) || !exactKeys(r, ["seq", "hash", "method", "result"]) || r.seq !== seq || !sha256Hex(r.hash) || !SEQ_METHODS.includes(r.method as SeqMethod)) return false;
    if (!isResult(r.result, seq, ledger.recordId, high, generation)) return false;
  }
  const ticket = (t: unknown) => safeInt(t, 1) && t <= generation;
  const appliedSeq = (s: unknown) => safeInt(s, 1) && s <= applied;
  if (!Array.isArray(x.docs) || x.docs.length > MAX_DOCS) return false;
  const seen = new Set<string>();
  let activeWrites = 0;
  for (const d of x.docs) {
    if (!obj(d) || !exactKeys(d, ["doc", "path", "segments", "editRefs", "write", "flushed"]) || !isDocRef(d.doc) || !bound(d.doc) || !receiptPath(d.path)) return false;
    const key = docKey(d.doc, d.path);
    if (seen.has(key)) return false;
    seen.add(key);
    if (!Array.isArray(d.segments) || d.segments.length > MAX_SEGMENTS) return false;
    let last = -1;
    for (const s of d.segments) {
      if (!obj(s) || !exactKeys(s, ["throughGen", "at", "ticket"]) || !safeInt(s.throughGen) || s.throughGen <= last || !isFiniteNum(s.at) || !ticket(s.ticket)) return false;
      last = s.throughGen;
    }
    if (!Array.isArray(d.editRefs) || d.editRefs.length > MAX_EDIT_REFS) return false;
    if (!d.editRefs.every((r) => obj(r) && exactKeys(r, ["seq", "throughGen", "ticket"]) && appliedSeq(r.seq) && safeInt(r.throughGen) && ticket(r.ticket))) return false;
    if (d.write !== null) {
      const w = d.write;
      if (!obj(w) || !exactKeys(w, ["seq", "gen", "intent", "token"]) || !appliedSeq(w.seq) || !safeInt(w.gen) || !hex32(w.intent) || !ticket(w.token)) return false;
      const mark = own(writes, d.path);
      const owner = mark?.owner;
      if (!mark?.active || mark.gen !== w.token || !owner || "unknown" in owner || owner.clientId !== clientId || owner.seq !== w.seq || owner.intent !== w.intent || owner.path !== d.path || !sameDoc(owner.doc, d.doc)) return false;
      activeWrites++;
    }
    if (d.flushed !== null) {
      const f = d.flushed;
      if (!obj(f) || !exactKeys(f, ["gen", "blobOid", "from", "ackGen", "seq"]) || !safeInt(f.gen) || !hex(f.blobOid) || !isFiniteNum(f.from) || !ticket(f.ackGen) || !appliedSeq(f.seq)) return false;
    }
    // Freed rows are removed; an empty one was not written by this engine.
    if (d.segments.length === 0 && d.editRefs.length === 0 && d.write === null && d.flushed === null) return false;
  }
  if (activeWrites > MAX_ACTIVE_WRITES) return false;
  if (!Array.isArray(x.proof) || x.proof.length > MAX_PROOF) return false;
  for (const p of x.proof) {
    if (!obj(p) || !exactKeys(p, ["doc", "path", "gen", "blobOid", "ackGen", "flushSeq", "state", "snapshotSeq", "snapshot"]) || !isDocRef(p.doc) || !bound(p.doc) || !receiptPath(p.path)) return false;
    if (!safeInt(p.gen) || !hex(p.blobOid) || !ticket(p.ackGen) || !appliedSeq(p.flushSeq)) return false;
    const captured = p.state === "captured";
    if (!captured && p.state !== "registered" && p.state !== "mismatch") return false;
    if (captured ? !(safeInt(p.snapshotSeq, 1) && hex(p.snapshot)) : !(p.snapshotSeq === null && p.snapshot === null)) return false;
  }
  if (!Array.isArray(x.verified) || x.verified.length > MAX_VERIFIED) return false;
  for (const v of x.verified) {
    if (!obj(v) || !exactKeys(v, ["doc", "path", "gen", "blobOid", "snapshot", "snapshotSeq", "at"]) || !isDocRef(v.doc) || !bound(v.doc) || !receiptPath(v.path)) return false;
    if (!safeInt(v.gen) || !hex(v.blobOid) || !hex(v.snapshot) || !safeInt(v.snapshotSeq, 1) || !isFiniteNum(v.at)) return false;
  }
  return true;
}

/**
 * The stored ledger if every field is well formed and consistent with the legacy record it sits in
 * (tickets, tokens and acknowledgements never ahead of its generation; every live write reference has its
 * exact tagged mark); otherwise null, which is ledger damage.
 */
export function parseLedger(value: unknown, legacy: Pick<DeadlineRecord, "generation" | "writes">): ReceiptLedger | null {
  if (!obj(value) || !exactKeys(value, ["v", "recordId", "activation", "captureQuarantine", "resetFloor", "counters", "clients"])) return null;
  if (value.v !== RECEIPT_LEDGER_VERSION || !hex32(value.recordId)) return null;
  const a = value.activation;
  if (a !== null && !(obj(a) && exactKeys(a, ["level", "by", "at", "handovers"]) && a.level === RECEIPT_ENGINE_LEVEL && isHelper(a.by) && isFiniteNum(a.at) && safeInt(a.handovers))) return null;
  const q = value.captureQuarantine;
  if (q !== null && !(obj(q) && exactKeys(q, ["since", "reason"]) && isFiniteNum(q.since) && q.reason === "incomplete-guards")) return null;
  const f = value.resetFloor;
  if (f !== null && !(obj(f) && exactKeys(f, ["from", "reason", "at"]) && isFiniteNum(f.from) && (f.reason === "converted" || f.reason === "damaged-ledger") && isFiniteNum(f.at))) return null;
  const c = value.counters;
  if (!obj(c) || !exactKeys(c, ["resets", "proofEvicted"]) || !safeInt(c.resets) || !safeInt(c.proofEvicted)) return null;
  if (!obj(value.clients) || Object.keys(value.clients).length > MAX_RECEIPT_CLIENTS) return null;
  for (const [clientId, stream] of Object.entries(value.clients)) {
    if (!hex32(clientId) || !isClientStream(clientId, stream, { recordId: value.recordId }, legacy.generation, legacy.writes)) return null;
  }
  // Every tagged mark is active and well formed. A tagged mark without a live write reference is an
  // orphan (its stream was reset); it stays a guard until its writer is proved gone.
  for (const [path, mark] of Object.entries(legacy.writes)) {
    if (mark.owner === undefined) continue;
    if (!mark.active || !isTaggedOwner(mark.owner)) return null;
    if (!("unknown" in mark.owner) && mark.owner.path !== path) return null;
  }
  return value as unknown as ReceiptLedger;
}

/**
 * Positive completeness rule for the guards of a record whose ledger is damaged (§11). The guards are the
 * legacy marks; a ledger reset loses only the live write references that let a writer end them. The set
 * is known complete only when the damaged ledger still states plainly that no quarantine stands, every
 * client's document list and live write reference is readable, and each live reference has its exact
 * active tagged mark (client, seq, intent, token, path, document). Anything unreadable on that path or any
 * disagreement means a guard may be lost; valid legacy fields alone never establish completeness.
 */
export function damagedGuardsComplete(damaged: unknown, writes: Readonly<Record<string, WriteMark>>): boolean {
  if (!obj(damaged) || !Object.prototype.hasOwnProperty.call(damaged, "captureQuarantine") || damaged.captureQuarantine !== null || !obj(damaged.clients)) return false;
  for (const [clientId, stream] of Object.entries(damaged.clients)) {
    if (!obj(stream) || !Array.isArray(stream.docs)) return false;
    for (const d of stream.docs) {
      if (!obj(d) || !Object.prototype.hasOwnProperty.call(d, "write")) return false;
      if (d.write === null) continue;
      const w = d.write;
      if (!obj(w) || !receiptPath(d.path) || !isDocRef(d.doc)) return false;
      const mark = own(writes, d.path);
      const owner = mark?.owner;
      if (!mark?.active || !isTaggedOwner(owner) || "unknown" in owner) return false;
      if (owner.clientId !== clientId || owner.path !== d.path || owner.seq !== w.seq || owner.intent !== w.intent || mark.gen !== w.token || !sameDoc(owner.doc, d.doc)) return false;
    }
  }
  return true;
}

/** What a record's `receipts` field holds, before strict validation of a version-2 ledger. */
export function ledgerKind(receipts: unknown): LedgerKind {
  if (receipts === undefined) return "none";
  if (obj(receipts) && Number.isSafeInteger(receipts.v)) return receipts.v === RECEIPT_LEDGER_VERSION ? "v2" : "unsupported";
  return "damaged";
}

/** The record's validated ledger, or null when it has none or holds an opaque newer one. */
export function ledgerOf(record: DeadlineRecord): ReceiptLedger | null {
  return ledgerKind(record.receipts) === "v2" ? (record.receipts as ReceiptLedger) : null;
}

export function newReceiptId(): string {
  return randomBytes(16).toString("hex");
}

export function freshLedger(reset: ReceiptLedger["resetFloor"], counters: ReceiptLedger["counters"], quarantine: ReceiptLedger["captureQuarantine"] = null): ReceiptLedger {
  return { v: 2, recordId: newReceiptId(), activation: null, captureQuarantine: quarantine, resetFloor: reset, counters, clients: {} };
}

/** Counters of a ledger that is being replaced: kept monotonic when readable, with one more reset. */
export function nextCounters(old: unknown): ReceiptLedger["counters"] {
  const c = obj(old) && obj(old.counters) ? old.counters : {};
  return { resets: (safeInt(c.resets) ? c.resets : 0) + 1, proofEvicted: safeInt(c.proofEvicted) ? c.proofEvicted : 0 };
}

/** Every finite time under an `at`, `from` or `since` key anywhere in a value (for floors over unreadable ledgers). */
export function finiteTimesIn(value: unknown, out: number[] = []): number[] {
  if (Array.isArray(value)) for (const item of value) finiteTimesIn(item, out);
  else if (obj(value)) {
    for (const [key, item] of Object.entries(value)) {
      if ((key === "at" || key === "from" || key === "since") && isFiniteNum(item)) out.push(item);
      else finiteTimesIn(item, out);
    }
  }
  return out;
}

/** Earliest debt time the ledger holds (segments, blob-bound debt, reset floor, quarantine); opaque ledgers count every time they name. */
export function ledgerOldest(receipts: unknown): number | null {
  const kind = ledgerKind(receipts);
  if (kind === "none") return null;
  if (kind !== "v2") {
    const times = finiteTimesIn(receipts);
    return times.length === 0 ? null : Math.min(...times);
  }
  const ledger = receipts as ReceiptLedger;
  let oldest: number | null = null;
  const take = (t: number) => { oldest = oldest === null ? t : Math.min(oldest, t); };
  if (ledger.resetFloor) take(ledger.resetFloor.from);
  if (ledger.captureQuarantine) take(ledger.captureQuarantine.since);
  for (const stream of Object.values(ledger.clients)) {
    for (const d of stream.docs) {
      for (const s of d.segments) take(s.at);
      if (d.flushed) take(d.flushed.from);
    }
  }
  return oldest;
}

/** Earliest unflushed segment time in the ledger (for the aggregate unflushed-edit status). */
export function ledgerUnflushedSince(receipts: unknown): number | null {
  const ledger = ledgerKind(receipts) === "v2" ? (receipts as ReceiptLedger) : null;
  let oldest: number | null = null;
  for (const stream of Object.values(ledger?.clients ?? {})) for (const d of stream.docs) for (const s of d.segments) oldest = oldest === null ? s.at : Math.min(oldest, s.at);
  return oldest;
}

export const docKey = (doc: DocRef, path: string) => `${doc.owner}/${doc.ownerEpoch}/${doc.docEpoch}/${path}`;

/** Removes document rows that hold nothing (no debt, no live reference). */
export function freeEmptyDocs(stream: ClientStream): void {
  stream.docs = stream.docs.filter((d) => d.segments.length > 0 || d.editRefs.length > 0 || d.write !== null || d.flushed !== null);
}

/** Deep copy of a ledger for a pure transition (records are JSON values). */
export function cloneLedger(ledger: ReceiptLedger): ReceiptLedger {
  return structuredClone(ledger);
}

// ---------------------------------------------------------------------------------------------------
// Request hash (deduplication identity).

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (obj(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value === undefined ? null : value);
}

export const HASHED_FIELDS: Record<SeqMethod, readonly string[]> = {
  noteEdit: ["seq", "path", "doc", "throughGen", "at"],
  noteWriteStart: ["seq", "path", "doc", "gen", "intent", "writer", "at"],
  noteFlush: ["seq", "path", "doc", "gen", "intent", "editRef", "writeRef", "blobOid"],
  noteWriteAbandon: ["seq", "path", "doc", "gen", "intent", "writeRef"],
  adopt: ["seq", "path", "from", "to"],
};

/** sha256 over canonical JSON of [method, vault, body fields in declared order]; `id` and `ackedThrough` excluded. */
export function requestHash(req: { method: SeqMethod; vault: string } & Record<string, unknown>): string {
  const body = [req.method, req.vault, ...HASHED_FIELDS[req.method].map((k) => req[k] ?? null)];
  return createHash("sha256").update(canonical(body)).digest("hex");
}

// ---------------------------------------------------------------------------------------------------
// Capture and publication safety.

/** What a capture holds on to between its record reads: the ledger identity, and whether it was reset. */
export interface SafetyStamp { recordId: string | null; reset: boolean }

/**
 * Whether capture or publication may proceed on this record: not while a quarantine stands (write guards
 * could not be recovered completely) or while the ledger is of another version (its guards are unknown).
 */
export function recordSafety(record: DeadlineRecord): { stamp: SafetyStamp } | { unsafe: string } {
  if (ledgerKind(record.receipts) === "unsupported") return { unsafe: "the deadline record holds a receipt ledger from a newer engine; capture and publication stay stopped" };
  const ledger = ledgerOf(record);
  if (ledger?.captureQuarantine) return { unsafe: "the deadline record was replaced without all of its write guards; capture and publication stay stopped until a repair confirms every writer finished" };
  return { stamp: { recordId: ledger?.recordId ?? null, reset: ledger?.resetFloor != null } };
}

/** Null while `record` is still the one `before` was taken from (ordinary receipt changes allowed); else why not. */
export function stampBroken(before: SafetyStamp, record: DeadlineRecord): string | null {
  const now = recordSafety(record);
  if ("unsafe" in now) return now.unsafe;
  const replaced = before.recordId !== null ? now.stamp.recordId !== before.recordId : now.stamp.recordId !== null && now.stamp.reset;
  return replaced ? "the deadline record was replaced while the capture was reading; the capture was discarded" : null;
}
