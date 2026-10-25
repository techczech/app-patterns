/**
 * Local helper protocol, version 2: the receipts lane. Same framing as protocol 1 (newline-delimited JSON,
 * MAX_LINE_BYTES per request, MAX_REPLY_BYTES per reply, `{id, ok, result | error}` envelopes), on a
 * connection of its own. Protocol 1 (status, syncNow) is unchanged and stays on its own connection.
 *
 * A receipts connection starts with a strict hello: exactly `type`, `protocol: 2`, `lane: "receipts"`,
 * `client`, `clientId` (32 lowercase hex), `clientEpoch` (positive integer), `writer` (the client process's
 * incarnation, with the same clientEpoch, or null) and `capabilities: ["receipts-2"]`. The helper answers
 * with exactly `type`, `ok`, `protocol: 2`, `lane`, `helperVersion`, `engineLevel: 1` and `capabilities`.
 * A protocol-2 hello without a `lane` field is a protocol-1-style hello and gets protocol 1's refusal.
 *
 * Methods: `openStream`, `noteEdit`, `noteWriteStart`, `noteFlush`, `noteWriteAbandon`, `adopt` (the
 * engine's receipt requests, receipt-transitions.ts) and `receiptStatus {vault, want}`. Every request is
 * checked here for its exact key set and field shapes before anything else; the vault must be a registered
 * id and every path a worktree-relative path the vault's registered scope includes. A request cannot
 * carry a folder, scope, remote, command, attestation or gone-process proof: those come from the helper's
 * configuration and its own observations. Writer fields are checked for shape only; whether a writer is
 * the session's own is the engine's check after duplicate detection.
 *
 * The client side validates every reply against the request it answers: the exact key set of every
 * object, each union variant, ids, object ids, document references, record and stream identities.
 */
import { MAX_WANT, RECEIPT_ENGINE_LEVEL, exactKeys, hex32, isDocRef, isHelper, isWriter, obj, receiptPath, safeInt, sameDoc, type DocRef, type ReceiptLimits, type ReceiptResult, type RefusalCode, type WriterIncarnation } from "../receipt-ledger.ts";
import type { DocProofView, ReceiptStatusView, WantedDoc } from "../receipt-status.ts";
import { checkOpenStreamRequest, checkSeqRequest, type OpenStreamRequest, type OpenStreamResult, type ReceiptErrorCode, type SeqRequest, type StreamIdentity } from "../receipt-transitions.ts";
import { isVaultId } from "./protocol.ts";

export const RECEIPTS_PROTOCOL_VERSION = 2;
export const RECEIPTS_CAPABILITY = "receipts-2";
/** Lowest helper version whose receipts lane a client accepts. */
export const MIN_RECEIPTS_HELPER_VERSION = "0.2.0";

export type LaneErrorCode = ReceiptErrorCode | "out-of-scope" | "unknown-vault" | "unknown-method" | "hello-required" | "protocol-mismatch" | "stopping" | "unavailable";
export const LANE_ERROR_CODES: readonly LaneErrorCode[] = [
  "bad-request", "stream-required", "superseded", "activation-refused", "unsupported-ledger", "busy", "ack-ahead", "out-of-order", "window-full", "clock-ahead",
  "pressure", "ledger-full", "retired", "conflict", "outcome-unknown", "internal", "out-of-scope", "unknown-vault", "unknown-method", "hello-required", "protocol-mismatch",
  "stopping", "unavailable",
];

export interface ReceiptsHello {
  type: "hello";
  protocol: 2;
  lane: "receipts";
  client: string;
  clientId: string;
  clientEpoch: number;
  writer: WriterIncarnation | null;
  capabilities: [typeof RECEIPTS_CAPABILITY];
}

export interface ReceiptsHelloOk {
  type: "hello";
  ok: true;
  protocol: 2;
  lane: "receipts";
  helperVersion: string;
  engineLevel: typeof RECEIPT_ENGINE_LEVEL;
  capabilities: [typeof RECEIPTS_CAPABILITY];
}

export interface ReceiptStatusRequest { id: number; method: "receiptStatus"; vault: string; want: WantedDoc[] }
export type LaneRequest = OpenStreamRequest | SeqRequest | ReceiptStatusRequest;
export type LaneErrorBody = { code: LaneErrorCode; message: string; stream?: StreamIdentity };
export type LaneResponse = { id: number; ok: true; result: unknown } | { id: number | null; ok: false; error: LaneErrorBody };

export class LaneError extends Error {
  readonly code: LaneErrorCode;
  readonly id: number | null;
  readonly stream?: StreamIdentity;
  constructor(code: LaneErrorCode, message: string, id: number | null = null, stream?: StreamIdentity) {
    super(message);
    this.name = "LaneError";
    this.code = code;
    this.id = id;
    if (stream) this.stream = stream;
  }
}

const CLIENT = /^[\x20-\x7e]{1,100}$/;
const MAX_ERROR_MESSAGE = 2_000;
const SEQ_METHODS = ["noteEdit", "noteWriteStart", "noteFlush", "noteWriteAbandon", "adopt"] as const;

function object(line: string, id: number | null = null): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new LaneError("bad-request", "message is not JSON", id);
  }
  if (!obj(value)) throw new LaneError("bad-request", "message must be a JSON object", id);
  return value;
}

/** True when a first line asks for the receipts lane (protocol 2 with a `lane` field); it is then parsed strictly. */
export function asksForReceiptsLane(line: string): boolean {
  try {
    const v: unknown = JSON.parse(line);
    return obj(v) && v.type === "hello" && v.protocol === RECEIPTS_PROTOCOL_VERSION && Object.prototype.hasOwnProperty.call(v, "lane");
  } catch {
    return false;
  }
}

export function parseReceiptsHello(line: string): ReceiptsHello {
  const v = object(line);
  if (!exactKeys(v, ["type", "protocol", "lane", "client", "clientId", "clientEpoch", "writer", "capabilities"])) throw new LaneError("bad-request", "a receipts hello has exactly type, protocol, lane, client, clientId, clientEpoch, writer and capabilities");
  if (v.type !== "hello" || v.protocol !== RECEIPTS_PROTOCOL_VERSION) throw new LaneError("protocol-mismatch", "the receipts lane speaks protocol 2");
  if (v.lane !== "receipts") throw new LaneError("protocol-mismatch", "protocol 2 has only the receipts lane");
  if (typeof v.client !== "string" || !CLIENT.test(v.client)) throw new LaneError("bad-request", "hello needs a printable client name");
  if (!hex32(v.clientId)) throw new LaneError("bad-request", "clientId must be 32 lowercase hex digits");
  if (!safeInt(v.clientEpoch, 1)) throw new LaneError("bad-request", "clientEpoch must be a positive integer");
  if (v.writer !== null && !(isWriter(v.writer) && v.writer.clientEpoch === v.clientEpoch)) throw new LaneError("bad-request", "writer must be null or this process's incarnation with the hello's clientEpoch");
  if (!Array.isArray(v.capabilities) || v.capabilities.length !== 1 || v.capabilities[0] !== RECEIPTS_CAPABILITY) throw new LaneError("bad-request", `capabilities must be ["${RECEIPTS_CAPABILITY}"]`);
  return {
    type: "hello", protocol: 2, lane: "receipts", client: v.client, clientId: v.clientId, clientEpoch: v.clientEpoch,
    writer: v.writer === null ? null : { ...(v.writer as WriterIncarnation) }, capabilities: [RECEIPTS_CAPABILITY],
  };
}

/** Static checks of one request line: exact keys, field shapes, a vault id. Scope and registration are the session's. */
export function parseLaneRequest(line: string): LaneRequest {
  const v = object(line);
  const id = v.id;
  if (!safeInt(id)) throw new LaneError("bad-request", "request needs a nonnegative integer id");
  const rid = id;
  if (!isVaultId(v.vault)) throw new LaneError("bad-request", "vault must be a registered vault id", rid);
  if (v.method === "openStream") {
    if (!checkOpenStreamRequest(v)) throw new LaneError("bad-request", "openStream has exactly id, method, vault, knownRecordId, knownStreamId, nextSeq (positive) and ackedThrough", rid);
    return { ...v } as unknown as OpenStreamRequest;
  }
  if (v.method === "receiptStatus") {
    const want = v.want;
    if (!exactKeys(v, ["id", "method", "vault", "want"]) || !Array.isArray(want) || want.length > MAX_WANT || !want.every((w) => obj(w) && exactKeys(w, ["path", "doc"]) && receiptPath(w.path) && isDocRef(w.doc))) {
      throw new LaneError("bad-request", `receiptStatus has exactly id, method, vault and want (at most ${MAX_WANT} {path, doc})`, rid);
    }
    return { id: rid, method: "receiptStatus", vault: v.vault, want: want.map((w) => ({ path: w.path, doc: { ...w.doc } })) as WantedDoc[] };
  }
  if (typeof v.method === "string" && (SEQ_METHODS as readonly string[]).includes(v.method)) {
    // The object format is the vault's; both lengths pass here and the engine checks the exact one.
    if (!checkSeqRequest(v, "sha1") && !checkSeqRequest(v, "sha256")) throw new LaneError("bad-request", `${v.method} is not well formed: exact keys, positive seq, worktree-relative path, document reference and field shapes`, rid);
    return structuredClone(v) as unknown as SeqRequest;
  }
  throw new LaneError("unknown-method", "unknown method", rid);
}

/** Every path a request names. */
export function requestPaths(request: LaneRequest): string[] {
  if (request.method === "openStream") return [];
  if (request.method === "receiptStatus") return request.want.map((w) => w.path);
  return [request.path];
}

export function encodeLane(message: ReceiptsHello | ReceiptsHelloOk | LaneResponse | { type: "hello"; ok: false; protocol: number; error: LaneErrorBody } | Record<string, unknown>): string {
  return `${JSON.stringify(message)}\n`;
}

// ---------------------------------------------------------------------------------------------------
// Client-side reply validation. Each throws LaneError("bad-request", ...) for anything but an exact reply.

const bad = (message: string) => new LaneError("bad-request", message);
const isFiniteNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isOid = (x: unknown): x is string => typeof x === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(x);

/** "0.2.0" ≥ "0.2.0"; numeric dotted versions only (a suffix makes the version unacceptable). */
export function versionAtLeast(version: string, minimum: string): boolean {
  const parse = (v: string) => (/^\d{1,6}(\.\d{1,6}){2}$/.test(v) ? v.split(".").map(Number) : null);
  const a = parse(version);
  const b = parse(minimum);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return true;
}

function errorBody(value: unknown): LaneErrorBody {
  if (!obj(value)) throw bad("error must be an object");
  const hasStream = Object.prototype.hasOwnProperty.call(value, "stream");
  if (!exactKeys(value, hasStream ? ["code", "message", "stream"] : ["code", "message"])) throw bad("error has unexpected fields");
  if (!(LANE_ERROR_CODES as readonly unknown[]).includes(value.code)) throw bad("error has an unknown code");
  if (typeof value.message !== "string" || value.message.length > MAX_ERROR_MESSAGE) throw bad("error needs a short message");
  if (!hasStream) return { code: value.code as LaneErrorCode, message: value.message };
  if (!checkStreamIdentity(value.stream)) throw bad("error carries a malformed stream identity");
  return { code: value.code as LaneErrorCode, message: value.message, stream: { ...value.stream } };
}

export function checkStreamIdentity(x: unknown): x is StreamIdentity {
  return obj(x) && exactKeys(x, ["recordId", "streamId", "base", "appliedThrough", "ackedThrough"]) && hex32(x.recordId) && hex32(x.streamId)
    && safeInt(x.base) && safeInt(x.ackedThrough) && safeInt(x.appliedThrough) && x.base <= x.ackedThrough && x.ackedThrough <= x.appliedThrough;
}

/** The helper's answer to a receipts hello: accepted (exact, engine level 1, a new enough helper) or refused. */
export function checkReceiptsHelloReply(line: string): { ok: true; hello: ReceiptsHelloOk } | { ok: false; code: string; message: string } {
  const v = object(line);
  if (v.type !== "hello" || typeof v.ok !== "boolean") throw bad("not a hello answer");
  if (!v.ok) {
    // An older helper refuses in its own protocol's terms; any well-formed refusal means "no receipts lane".
    if (!exactKeys(v, ["type", "ok", "protocol", "error"]) || !safeInt(v.protocol) || !obj(v.error) || !exactKeys(v.error, ["code", "message"])) throw bad("malformed hello refusal");
    if (typeof v.error.code !== "string" || typeof v.error.message !== "string" || v.error.code.length > 64 || v.error.message.length > MAX_ERROR_MESSAGE) throw bad("malformed hello refusal");
    return { ok: false, code: v.error.code, message: v.error.message };
  }
  if (!exactKeys(v, ["type", "ok", "protocol", "lane", "helperVersion", "engineLevel", "capabilities"])) throw bad("hello answer has unexpected or missing fields");
  if (v.protocol !== RECEIPTS_PROTOCOL_VERSION || v.lane !== "receipts") throw bad("hello answer is not for the receipts lane");
  if (v.engineLevel !== RECEIPT_ENGINE_LEVEL) throw bad("hello answer names another engine level");
  if (!Array.isArray(v.capabilities) || v.capabilities.length !== 1 || v.capabilities[0] !== RECEIPTS_CAPABILITY) throw bad("hello answer names other capabilities");
  if (typeof v.helperVersion !== "string" || !CLIENT.test(v.helperVersion) || !versionAtLeast(v.helperVersion, MIN_RECEIPTS_HELPER_VERSION)) throw bad(`hello answer needs helper version ${MIN_RECEIPTS_HELPER_VERSION} or later`);
  return { ok: true, hello: { type: "hello", ok: true, protocol: 2, lane: "receipts", helperVersion: v.helperVersion, engineLevel: RECEIPT_ENGINE_LEVEL, capabilities: [RECEIPTS_CAPABILITY] } };
}

/** A response envelope answering request `expectedId` exactly; an error with a null id is also returned (the connection is then unusable). */
export function checkLaneResponse(line: string): LaneResponse {
  const v = object(line);
  const id = v.id;
  if (id !== null && !safeInt(id)) throw bad("response needs a nonnegative integer id or null");
  if (v.ok === true) {
    if (!exactKeys(v, ["id", "ok", "result"]) || id === null) throw bad("a successful response has exactly id, ok and result");
    return { id, ok: true, result: v.result };
  }
  if (v.ok === false) {
    if (!exactKeys(v, ["id", "ok", "error"])) throw bad("an error response has exactly id, ok and error");
    return { id: id as number | null, ok: false, error: errorBody(v.error) };
  }
  throw bad("response needs ok true or false");
}

const LIMIT_KEYS: readonly (keyof ReceiptLimits)[] = ["window", "maxClients", "maxOwners", "maxDocs", "maxSegments", "maxEditRefs", "maxActiveWrites", "maxProof", "maxVerified", "maxWant"];
function isLimits(x: unknown): x is ReceiptLimits {
  return obj(x) && exactKeys(x, LIMIT_KEYS) && LIMIT_KEYS.every((k) => safeInt(x[k], 1));
}

function isListView(x: unknown, item: (i: unknown) => boolean): boolean {
  return obj(x) && exactKeys(x, ["count", "items", "omitted"]) && safeInt(x.count) && safeInt(x.omitted) && Array.isArray(x.items) && x.items.length + x.omitted === x.count && x.items.every(item);
}

/** An openStream answer consistent with its request: a rebased stream starts at nextSeq − 1; a retained one keeps the known identities. */
export function checkOpenStreamResult(x: unknown, request: OpenStreamRequest): OpenStreamResult {
  if (!obj(x) || !exactKeys(x, ["recordId", "streamId", "rebased", "objectFormat", "base", "appliedThrough", "ackedThrough", "window", "limits", "owners"])) throw bad("openStream result has unexpected or missing fields");
  if (!hex32(x.recordId) || !hex32(x.streamId) || typeof x.rebased !== "boolean" || (x.objectFormat !== "sha1" && x.objectFormat !== "sha256")) throw bad("openStream result identities are malformed");
  if (!safeInt(x.base) || !safeInt(x.ackedThrough) || !safeInt(x.appliedThrough) || !(x.base <= x.ackedThrough && x.ackedThrough <= x.appliedThrough)) throw bad("openStream result counters are inconsistent");
  if (!safeInt(x.window, 1) || !isLimits(x.limits) || x.limits.window !== x.window) throw bad("openStream result limits are malformed");
  if (!isListView(x.owners, (o) => obj(o) && exactKeys(o, ["owner", "epoch", "docs", "activeWrites"]) && hex32(o.owner) && safeInt(o.epoch, 1) && safeInt(o.docs) && safeInt(o.activeWrites))) throw bad("openStream result owners are malformed");
  if (x.rebased) {
    const start = request.nextSeq - 1;
    if (x.base !== start || x.appliedThrough !== start || x.ackedThrough !== start) throw bad("a new stream must start at nextSeq - 1");
  } else if (x.recordId !== request.knownRecordId || x.streamId !== request.knownStreamId || x.ackedThrough < request.ackedThrough) {
    throw bad("a retained stream must keep the identities and acknowledgement the client named");
  }
  return structuredClone(x) as unknown as OpenStreamResult;
}

const OK_FOR: Record<SeqRequest["method"], string> = { noteEdit: "edit", noteWriteStart: "write-started", noteFlush: "flushed", noteWriteAbandon: "write-abandoned", adopt: "adopted" };
const REFUSALS: readonly RefusalCode[] = ["ref-invalid", "gen-mismatch", "write-active", "stale-writer", "owner-mismatch", "adopt-invalid"];
const APPLIED = ["seq", "recordId", "durable", "epoch"];

/** A sequenced result for exactly this request's seq, this stream's record and an epoch no later than the client's. */
export function checkReceiptResult(x: unknown, request: SeqRequest, recordId: string, clientEpoch: number): ReceiptResult {
  if (!obj(x) || x.seq !== request.seq || x.recordId !== recordId || x.durable !== true || !safeInt(x.epoch, 1) || x.epoch > clientEpoch) throw bad("receipt result does not answer this seq on this record");
  const ok = "refused" in x
    ? exactKeys(x, [...APPLIED, "refused"]) && REFUSALS.includes(x.refused as RefusalCode)
    : x.ok === OK_FOR[request.method] && (() => {
      switch (x.ok) {
        case "edit": return exactKeys(x, [...APPLIED, "ok", "ticket", "retiredRefs"]) && safeInt(x.ticket, 1) && Array.isArray(x.retiredRefs) && x.retiredRefs.every((r) => safeInt(r, 1));
        case "write-started": return exactKeys(x, [...APPLIED, "ok", "token"]) && safeInt(x.token, 1);
        case "flushed": return exactKeys(x, [...APPLIED, "ok", "ackGen", "endedWrite"]) && safeInt(x.ackGen, 1) && typeof x.endedWrite === "boolean";
        case "write-abandoned": return exactKeys(x, [...APPLIED, "ok"]);
        case "adopted": return exactKeys(x, [...APPLIED, "ok", "segments"]) && safeInt(x.segments);
        default: return false;
      }
    })();
  if (!ok) throw bad("receipt result is not a well-formed answer to this method");
  return structuredClone(x) as unknown as ReceiptResult;
}

function isAgg(x: unknown): boolean {
  return obj(x) && exactKeys(x, ["count", "oldestAt"]) && safeInt(x.count) && (x.count === 0 ? x.oldestAt === null : isFiniteNum(x.oldestAt));
}

const sameRef = (a: unknown, b: DocRef) => isDocRef(a) && sameDoc(a, b);

/** The state the engine's view gives a row (receipt-status.ts): unflushed segments, else proof, else a flushed blob still owed, else verified. */
function expectedState(x: { unflushedThroughGen: unknown; flushed: unknown; proof: unknown; verified: unknown }): string {
  if (x.unflushedThroughGen !== null) return "debt";
  if (x.proof !== null) return (x.proof as { state: string }).state;
  if (x.flushed !== null) return "debt";
  return x.verified !== null ? "verified" : "none";
}

/** Every object id a row names. */
function rowOids(x: DocProofView): string[] {
  return [x.flushed?.blobOid, x.proof?.blobOid, x.verified?.blobOid, x.verified?.snapshot].filter((o): o is string => o !== undefined);
}

function isDocView(x: unknown, want: WantedDoc): x is DocProofView {
  if (!obj(x) || !exactKeys(x, ["path", "doc", "state", "unflushedThroughGen", "flushed", "proof", "verified", "activeWrite"])) return false;
  if (x.path !== want.path || !sameRef(x.doc, want.doc)) return false;
  if (!["none", "debt", "registered", "captured", "mismatch", "verified"].includes(x.state as string)) return false;
  if (x.unflushedThroughGen !== null && !safeInt(x.unflushedThroughGen)) return false;
  const f = x.flushed;
  if (f !== null && !(obj(f) && exactKeys(f, ["gen", "blobOid", "ackGen"]) && safeInt(f.gen) && isOid(f.blobOid) && safeInt(f.ackGen, 1))) return false;
  const p = x.proof;
  if (p !== null && !(obj(p) && exactKeys(p, ["gen", "blobOid", "state", "snapshotSeq"]) && safeInt(p.gen) && isOid(p.blobOid) && ["registered", "captured", "mismatch"].includes(p.state as string)
    && (p.state === "captured" ? safeInt(p.snapshotSeq, 1) : p.snapshotSeq === null))) return false;
  const v = x.verified;
  if (v !== null && !(obj(v) && exactKeys(v, ["gen", "blobOid", "snapshot", "snapshotSeq", "at"]) && safeInt(v.gen) && isOid(v.blobOid) && isOid(v.snapshot) && safeInt(v.snapshotSeq, 1) && isFiniteNum(v.at))) return false;
  // One state for these rows: older verified or proof rows may stand beside newer debt, but the state is the engine's precedence.
  if (x.state !== expectedState({ unflushedThroughGen: x.unflushedThroughGen, flushed: f, proof: p, verified: v })) return false;
  return typeof x.activeWrite === "boolean";
}

/** What a status reply must match: this connection's hello identity and the stream (with its object format) its openStream returned, if any. */
export interface StatusExpectation {
  clientId: string;
  clientEpoch: number;
  stream: { recordId: string; streamId: string; objectFormat: "sha1" | "sha256" } | null;
}

/**
 * A receipt status for exactly the requested documents, in request order, on this client's stream. Counts
 * are taken as given (exact, from the whole record); `docs.omitted` says how many requested rows the reply
 * left out, which the caller must treat as unknown, never as absent. The session epoch is this
 * connection's own; once this connection opened the stream its high-water mark is at least that epoch
 * (a newer process may have raised it); no owner is bound above it. Every object id has one length: the
 * opened stream's object format, or (before an openStream) one length throughout.
 */
export function checkReceiptStatusView(x: unknown, want: readonly WantedDoc[], expected: StatusExpectation): ReceiptStatusView {
  const { clientId, stream } = expected;
  if (!obj(x) || !exactKeys(x, ["recordId", "observedGeneration", "observedAt", "activation", "captureQuarantine", "stream", "vault", "thisClient", "docs"])) throw bad("receipt status has unexpected or missing fields");
  if (!hex32(x.recordId) || !safeInt(x.observedGeneration) || !isFiniteNum(x.observedAt)) throw bad("receipt status identities are malformed");
  const a = x.activation;
  if (a !== null && !(obj(a) && exactKeys(a, ["by", "at", "handovers"]) && isHelper(a.by) && isFiniteNum(a.at) && safeInt(a.handovers))) throw bad("receipt status activation is malformed");
  const quarantine = (q: unknown) => q === null || (obj(q) && exactKeys(q, ["since", "reason"]) && isFiniteNum(q.since) && q.reason === "incomplete-guards");
  if (!quarantine(x.captureQuarantine)) throw bad("receipt status quarantine is malformed");
  const s = x.stream;
  if (!obj(s) || !exactKeys(s, ["clientId", "streamId", "epochHighWater", "sessionEpoch", "base", "appliedThrough", "ackedThrough", "replies", "docs", "limits"])) throw bad("receipt status stream is malformed");
  if (s.clientId !== clientId || !hex32(s.streamId) || !safeInt(s.epochHighWater, 1) || !safeInt(s.sessionEpoch, 1) || !safeInt(s.base) || !safeInt(s.ackedThrough) || !safeInt(s.appliedThrough)
    || !(s.base <= s.ackedThrough && s.ackedThrough <= s.appliedThrough) || !safeInt(s.replies) || s.replies !== s.appliedThrough - s.ackedThrough || !safeInt(s.docs) || !isLimits(s.limits)) throw bad("receipt status stream is inconsistent");
  if (stream && (x.recordId !== stream.recordId || s.streamId !== stream.streamId)) throw bad("receipt status names another record or stream");
  if (s.sessionEpoch !== expected.clientEpoch) throw bad("receipt status answers another session epoch");
  if (stream && s.epochHighWater < expected.clientEpoch) throw bad("receipt status names an epoch high-water mark below this connection's opened epoch");
  const vault = x.vault;
  if (!obj(vault) || !exactKeys(vault, ["oldestUnprotectedEdit", "legacyVaultWide", "legacyPerPath", "capturedUnverified", "pending", "unlisted", "activeWrites", "otherClientDebt", "captureQuarantine", "resetFloor", "counters"])) throw bad("receipt status vault is malformed");
  if (vault.oldestUnprotectedEdit !== null && !isFiniteNum(vault.oldestUnprotectedEdit)) throw bad("receipt status oldest edit is malformed");
  if (![vault.legacyVaultWide, vault.legacyPerPath, vault.capturedUnverified, vault.pending, vault.unlisted].every(isAgg)) throw bad("receipt status counts are malformed");
  const w = vault.activeWrites;
  if (!obj(w) || !exactKeys(w, ["untagged", "thisClient", "otherClient", "unknownOwner"]) || ![w.untagged, w.thisClient, w.otherClient, w.unknownOwner].every(isAgg)) throw bad("receipt status write counts are malformed");
  const o = vault.otherClientDebt;
  if (!obj(o) || !exactKeys(o, ["count", "oldestAt", "clients"]) || !isAgg({ count: o.count, oldestAt: o.oldestAt }) || !safeInt(o.clients) || o.clients > (o.count as number)) throw bad("receipt status other-client counts are malformed");
  if (!quarantine(vault.captureQuarantine)) throw bad("receipt status quarantine is malformed");
  const r = vault.resetFloor;
  if (r !== null && !(obj(r) && exactKeys(r, ["from", "reason"]) && isFiniteNum(r.from) && (r.reason === "converted" || r.reason === "damaged-ledger"))) throw bad("receipt status reset floor is malformed");
  const c = vault.counters;
  if (!obj(c) || !exactKeys(c, ["resets", "proofEvicted"]) || !safeInt(c.resets) || !safeInt(c.proofEvicted)) throw bad("receipt status counters are malformed");
  const t = x.thisClient;
  if (!obj(t) || !exactKeys(t, ["unflushed", "blobDebt", "activeWrites", "owners"]) || ![t.unflushed, t.blobDebt, t.activeWrites].every(isAgg)) throw bad("receipt status client counts are malformed");
  const high = s.epochHighWater;
  if (!isListView(t.owners, (e) => obj(e) && exactKeys(e, ["owner", "epoch", "unflushed", "blobDebt", "activeWrites"]) && hex32(e.owner) && safeInt(e.epoch, 1) && e.epoch <= high && isAgg(e.unflushed) && isAgg(e.blobDebt) && safeInt(e.activeWrites))) throw bad("receipt status owners are malformed");
  const d = x.docs;
  if (!obj(d) || !exactKeys(d, ["count", "items", "omitted"]) || d.count !== want.length || !safeInt(d.omitted) || !Array.isArray(d.items) || d.items.length + d.omitted !== want.length) throw bad("receipt status must account for every requested document");
  if (!d.items.every((item, i) => isDocView(item, want[i]!))) throw bad("receipt status rows must be the requested documents, in order");
  const lengths = new Set((d.items as DocProofView[]).flatMap(rowOids).map((o) => o.length));
  if (stream ? [...lengths].some((n) => n !== (stream.objectFormat === "sha1" ? 40 : 64)) : lengths.size > 1) throw bad("receipt status object ids do not match this checkout's one object format");
  return structuredClone(x) as unknown as ReceiptStatusView;
}

