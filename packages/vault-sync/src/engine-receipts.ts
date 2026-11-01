/**
 * The engine's receipt API: each call is one record-lock transaction with a 2 000 ms lock budget and
 * never takes the operation lock, so a receipt is never queued behind a capture, push or verification.
 *
 * Inside the transaction the record is read, the pure transition runs (receipt-transitions.ts), and the
 * result is made durable before the reply leaves: a new reply or acknowledgement advance is one atomic
 * replacement of deadline.json (temporary file synced, renamed, folder synced); a cached reply with nothing
 * to write still syncs the record file and its folder first. Failures map to the reply classes the client
 * acts on: `busy` (lock not acquired) and `internal` (failed before a temporary file was opened) did not
 * apply the receipt; `outcome-unknown` (failed from the temporary file onward, or the barrier failed) may
 * have applied, so the client resends the identical body with the same seq.
 *
 * Loading a damaged or older record writes too (an aside copy, then a replacement; engine-store.ts). A
 * failure of one of those after its temporary file opened is `outcome-unknown` like any other, and an
 * `internal` reply after one of them completed says so instead of claiming that nothing was written.
 */
import type { DeadlineRecord } from "./deadline.ts";
import { LockTimeoutError, PersistNotStarted, PersistOutcomeUnknown, RecordUnsafeError, loadRecord, saveRecord, syncDurable, withFolderLock, type EngineFolder, type RecoveryWrites } from "./engine-store.ts";
import { RECEIPT_LOCK_WAIT_MS, MAX_WANT } from "./receipt-ledger.ts";
import type { ReceiptResult } from "./receipt-ledger.ts";
import { checkWant, receiptStatusView, type ReceiptStatusView, type WantedDoc } from "./receipt-status.ts";
import {
  applyReceipt, checkGoneProofs, checkOpenStreamRequest, checkSeqRequest, checkSession, isReceiptError, openStream, releaseGoneWriters,
  type GoneWriterProof, type OpenStreamRequest, type OpenStreamResult, type PersistKind, type ReceiptError, type ReceiptSession, type SeqRequest,
} from "./receipt-transitions.ts";

export interface ReceiptsApi {
  /** Activation and stream negotiation (not sequenced); see receipt-transitions.ts openStream. */
  openStream(repo: string, session: ReceiptSession, attestation: unknown, request: OpenStreamRequest): Promise<OpenStreamResult | ReceiptError>;
  /** One sequenced receipt: noteEdit, noteWriteStart, noteFlush, noteWriteAbandon or adopt. */
  apply(repo: string, session: ReceiptSession, request: SeqRequest): Promise<ReceiptResult | ReceiptError>;
  /** Read-only view from one locked record read; `maxItems` bounds each list (counts stay exact). */
  status(repo: string, session: ReceiptSession, want: readonly WantedDoc[], options?: { maxItems?: number }): Promise<ReceiptStatusView | ReceiptError>;
  /** Ends exact tagged marks whose writer process was found gone; returns the released paths. */
  releaseGoneWriters(repo: string, proofs: readonly GoneWriterProof[], helperHost: string): Promise<{ released: string[] } | ReceiptError>;
}

export interface ReceiptsDeps {
  /** The checkout's engine folder and object format; may throw for a folder that is not a worktree root. */
  locate(repo: string): Promise<{ folder: EngineFolder; objectFormat: "sha1" | "sha256" }>;
  now(): number;
}

/** Test seam: runs after the reply is durable and before it is returned (a lost reply). */
export const receiptTestHooks: { beforeReply?: () => Promise<void> | void } = {};

const error = (code: ReceiptError["error"], message: string): ReceiptError => ({ error: code, message });

type Step<R> = { record: DeadlineRecord; reply: R | ReceiptError; persistKind: PersistKind | "read-only" };

/** One record-lock transaction: load, pure step, durable write or barrier, reply. */
async function transact<R>(folder: EngineFolder, step: (record: DeadlineRecord) => Step<R>): Promise<R | ReceiptError> {
  let phase: "lock" | "load" | "step" | "writing" = "lock";
  const recovery: RecoveryWrites = { aside: false, replaced: false };
  try {
    return await withFolderLock(folder.recordLockDir, { waitMs: RECEIPT_LOCK_WAIT_MS }, async () => {
      phase = "load";
      const record = await loadRecord(folder, recovery);
      phase = "step";
      const out = step(record);
      if (isReceiptError(out.reply) || out.persistKind === "read-only") return out.reply;
      phase = "writing";
      if (out.persistKind === "none") await syncDurable(folder.recordFile);
      else await saveRecord(folder, out.record);
      await receiptTestHooks.beforeReply?.();
      return out.reply;
    });
  } catch (caught) {
    if (phase === "lock") return caught instanceof LockTimeoutError ? error("busy", "the deadline record is locked by another writer; retry with the same seq") : error("internal", "could not take the record lock; nothing was written");
    if (caught instanceof RecordUnsafeError) return error("unsupported-ledger", caught.message);
    // Typed uncertainty first: a write that got past its temporary file may have landed, whichever phase ran it.
    if (caught instanceof PersistOutcomeUnknown) {
      return error("outcome-unknown", phase === "load"
        ? "a recovery write of the deadline record did not complete, so this receipt was not applied; resend the identical receipt with the same seq"
        : "the record write did not complete; resend the identical receipt with the same seq");
    }
    if (caught instanceof PersistNotStarted || phase !== "writing") {
      const detail = String((caught as Error)?.message ?? caught).slice(0, 200);
      if (!recovery.aside && !recovery.replaced) return error("internal", `nothing was written: ${detail}`);
      const done = recovery.replaced ? "copied aside and replaced" : "copied aside (the record itself is unchanged)";
      return error("internal", `this receipt was not applied, but the damaged deadline record was already ${done}: ${detail}`);
    }
    return error("outcome-unknown", "the reply could not be confirmed durable; resend the identical receipt with the same seq");
  }
}

export function createReceiptsApi(deps: ReceiptsDeps): ReceiptsApi {
  const where = async (repo: string) => {
    try {
      return await deps.locate(repo);
    } catch (caught) {
      return error("internal", `not a usable checkout: ${String((caught as Error)?.message ?? caught).slice(0, 200)}`);
    }
  };
  const badSession = () => error("bad-request", "the receipt session is not well formed");

  return {
    async openStream(repo, session, attestation, request) {
      if (!checkSession(session)) return badSession();
      if (!checkOpenStreamRequest(request)) return error("bad-request", "openStream request is not well formed");
      const at = await where(repo);
      if ("error" in at) return at;
      return transact(at.folder, (record) => {
        const out = openStream(record, session, attestation, request, deps.now(), at.objectFormat);
        return { record: out.record, reply: out.reply, persistKind: out.persist ? "full" : "none" };
      });
    },

    async apply(repo, session, request) {
      if (!checkSession(session)) return badSession();
      const at = await where(repo);
      if ("error" in at) return at;
      if (!checkSeqRequest(request, at.objectFormat)) return error("bad-request", "receipt request is not well formed");
      return transact(at.folder, (record) => applyReceipt(record, session, request, deps.now()));
    },

    async status(repo, session, want, options = {}) {
      if (!checkSession(session)) return badSession();
      if (!checkWant(want)) return error("bad-request", `want must list at most ${MAX_WANT} documents`);
      const maxItems = options.maxItems ?? MAX_WANT;
      if (!Number.isSafeInteger(maxItems) || maxItems < 0) return error("bad-request", "maxItems must be a non-negative integer");
      const at = await where(repo);
      if ("error" in at) return at;
      return transact(at.folder, (record) => ({ record, reply: receiptStatusView(record, session, want, maxItems, deps.now()), persistKind: "read-only" }));
    },

    async releaseGoneWriters(repo, proofs, helperHost) {
      if (!checkGoneProofs(proofs) || typeof helperHost !== "string" || helperHost.length === 0) return error("bad-request", "gone-writer proofs are not well formed");
      const at = await where(repo);
      if ("error" in at) return at;
      return transact(at.folder, (record) => {
        const out = releaseGoneWriters(record, proofs, helperHost);
        // Nothing released: nothing to write, and no reply depends on durability.
        return { record: out.record, reply: { released: out.released }, persistKind: out.released.length > 0 ? "full" : "read-only" };
      });
    },
  };
}
