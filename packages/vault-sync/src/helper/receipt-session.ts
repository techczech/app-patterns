/**
 * One receipts-lane connection (protocol 2) inside the helper.
 *
 * The connection's requests are answered one at a time, in order (the caller's queue, connection.ts).
 * Every request reaches only the engine's receipt API (`engine.receipts`): record lock, 2 000 ms budget,
 * never the operation lock, so a capture, push, verification or a held `syncNow` on a control connection
 * never delays it, and nothing here starts a cycle, runs Git or touches the network. (The engine resolves
 * a checkout's layout once per checkout with Git and keeps it; ps runs only for incarnation checks.)
 *
 * Authority stays with the helper's configuration: a request names a registered vault id; the engine is
 * called with that vault's registered real path; every path in a request must be in the vault's registered
 * scope (`out-of-scope` otherwise, before any record access). After the last await before every engine
 * call (openStream, a sequenced receipt, a gone-writer release, a status read) the registered path is
 * checked again to be its own real path, so a folder replaced while the helper observed a process or read
 * a hint is refused rather than taken for the registered checkout; for openStream, receipts and releases
 * the helper must also still hold every claim and not be stopping, checked in the calling function once
 * that path check has returned, with no await between this check and the engine call. The engine resolves
 * the path again itself; nothing here can exclude a replacement after that final check. The session identity (helper incarnation,
 * clientId, clientEpoch, writer) comes from the hello and the helper; the stream identities come from this
 * connection's own `openStream` per vault. One connection may address several registered vaults.
 *
 * Nothing is retried here: a reply the client did not receive is the client's to resend with the same
 * seq, and the engine's duplicate check returns the stored result. Every engine answer is passed on
 * unchanged, so an exact applied result reaches the client as stored and an uncertain one stays
 * `outcome-unknown`. A `superseded` answer closes the connection.
 *
 * Each request's work is registered with `track` before its first await, so a stopping helper can wait
 * for it to settle before it releases its claims; once stopping, new requests are refused.
 */
import type { ReceiptsApi } from "../engine-receipts.ts";
import { MAX_WANT, RECEIPT_ENGINE_LEVEL, type HelperIncarnation } from "../receipt-ledger.ts";
import type { ReceiptStatusView } from "../receipt-status.ts";
import { isReceiptError, type ReceiptError, type ReceiptSession } from "../receipt-transitions.ts";
import type { CompiledScope } from "../scope.ts";
import { attest, canonicalRegistration, goneWriterProofs, readRecordHint, type PriorShutdownEvidence } from "./activation.ts";
import type { RegisteredVault } from "./config.ts";
import type { ProcessObserver } from "./process-observer.ts";
import { MAX_REPLY_BYTES } from "./protocol.ts";
import { encodeLane, LaneError, parseLaneRequest, RECEIPTS_CAPABILITY, requestPaths, type LaneErrorCode, type ReceiptsHello, type ReceiptsHelloOk } from "./receipt-protocol.ts";
import { VIEW_ITEM_LIMITS } from "./status-view.ts";

export interface ReceiptVault {
  vault: RegisteredVault;
  scope: CompiledScope;
  /** The vault engine's receipt API; null when the engine has none (the lane answers `unavailable`). */
  receipts: ReceiptsApi | null;
  /** The checkout's deadline.json, for unlocked activation and mark hints; null when unknown. */
  recordFile: string | null;
}

export interface ReceiptLaneContext {
  vaults: ReadonlyMap<string, ReceiptVault>;
  helperVersion: string;
  /** This helper's incarnation; null when its start time cannot be read. */
  identity(): Promise<HelperIncarnation | null>;
  /** True while this helper holds its runtime-folder claim and every vault claim and is not stopping. */
  exclusive(): boolean;
  stopping(): boolean;
  observer: ProcessObserver;
  priorShutdown: PriorShutdownEvidence | null;
  /** Registers a request's work for `vault` until it settles. */
  track<T>(vault: string, work: Promise<T>): Promise<T>;
  now(): number;
}

export interface ReceiptLane {
  readonly hello: ReceiptsHelloOk;
  /** Answers one request line; `close` asks the caller to end the connection after sending `reply`. */
  handle(line: string): Promise<{ reply: string; close: boolean }>;
}

/** Receipt requests in progress, per vault. `settled` waits until none is left, including any added while it waits. */
export interface WorkTracker {
  track<T>(vault: string, work: Promise<T>): Promise<T>;
  /** Vaults with work in progress now. */
  busy(): string[];
  settled(): Promise<void>;
}

export function createWorkTracker(): WorkTracker {
  const work = new Map<string, Set<Promise<unknown>>>();
  return {
    track(vault, promise) {
      const set = work.get(vault) ?? new Set<Promise<unknown>>();
      work.set(vault, set);
      const entry: Promise<unknown> = promise.then(() => undefined, () => undefined).finally(() => set.delete(entry));
      set.add(entry);
      return promise;
    },
    busy: () => [...work].filter(([, set]) => set.size > 0).map(([vault]) => vault),
    async settled() {
      for (;;) {
        const pending = [...work.values()].flatMap((set) => [...set]);
        if (pending.length === 0) return;
        await Promise.allSettled(pending);
      }
    },
  };
}

const MAX_MESSAGE = 2_000;
const errorLine = (id: number | null, e: LaneError) =>
  encodeLane({ id, ok: false, error: { code: e.code, message: e.message.slice(0, MAX_MESSAGE), ...(e.stream ? { stream: e.stream } : {}) } });
const fromEngine = (out: ReceiptError, id: number) => new LaneError(out.error as LaneErrorCode, out.message, id, out.stream);

/** @internal Status reply in the largest sample that fits a reply line; counts are exact in every one. */
export function statusLine(id: number, view: ReceiptStatusView): string | null {
  for (const limit of VIEW_ITEM_LIMITS.map((l) => Math.min(l, MAX_WANT))) {
    const cut = <T>(list: { count: number; items: T[]; omitted: number }) => {
      const items = list.items.slice(0, limit);
      return { count: list.count, items, omitted: list.count - items.length };
    };
    const line = encodeLane({ id, ok: true, result: { ...view, thisClient: { ...view.thisClient, owners: cut(view.thisClient.owners) }, docs: cut(view.docs) } });
    if (Buffer.byteLength(line) <= MAX_REPLY_BYTES) return line;
  }
  return null;
}

export function openReceiptLane(hello: ReceiptsHello, ctx: ReceiptLaneContext): ReceiptLane {
  const streams = new Map<string, { recordId: string; streamId: string }>();
  const session = (self: HelperIncarnation, vault: string): ReceiptSession => ({
    helper: self, clientId: hello.clientId, clientEpoch: hello.clientEpoch, writer: hello.writer,
    recordId: streams.get(vault)?.recordId ?? null, streamId: streams.get(vault)?.streamId ?? null,
  });

  /** Exclusive ownership now; synchronous, so a writing engine call made next with no await is covered by it. */
  const requireExclusive = (id: number, when: string) => {
    if (ctx.exclusive()) return;
    throw new LaneError(ctx.stopping() ? "stopping" : "activation-refused", `this helper no longer holds every claim it needs (or is stopping) ${when}; every guard was kept`, id);
  };
  /**
   * The path fence before an engine call: the registered path still resolves to itself. Awaiting it
   * yields, so a writing caller checks `requireExclusive` itself after the await and then calls the engine
   * with no await between.
   */
  const fence = async (v: ReceiptVault, id: number) => {
    if (!(await canonicalRegistration(v.vault.path))) throw new LaneError("activation-refused", "the registered vault folder no longer resolves to its registered real path", id);
  };

  async function answer(id: number, request: ReturnType<typeof parseLaneRequest>, v: ReceiptVault, receipts: ReceiptsApi, called: { engine: boolean }): Promise<{ reply: string; close: boolean }> {
    const self = await ctx.identity();
    if (!self) throw new LaneError("activation-refused", "this helper's own process start time could not be read, so it cannot attest its incarnation", id);
    const vault = request.vault;

    if (request.method === "openStream") {
      requireExclusive(id, "before attesting");
      if (!(await canonicalRegistration(v.vault.path))) throw new LaneError("activation-refused", "the registered vault folder no longer resolves to its registered real path", id);
      const hint = v.recordFile ? await readRecordHint(v.recordFile) : null;
      // An unreadable record names no holder; the engine still refuses if another helper holds activation.
      const attested = await attest(self, hint?.activation ?? null, ctx.priorShutdown, ctx.observer);
      if ("refused" in attested) throw new LaneError("activation-refused", attested.refused, id);
      await fence(v, id);
      requireExclusive(id, "after attesting");
      called.engine = true;
      const out = await receipts.openStream(v.vault.path, session(self, vault), attested.attestation, request);
      if (isReceiptError(out)) {
        const e = fromEngine(out, id);
        return { reply: errorLine(id, e), close: e.code === "superseded" };
      }
      streams.set(vault, { recordId: out.recordId, streamId: out.streamId });
      return { reply: encodeLane({ id, ok: true, result: out }), close: false };
    }

    if (request.method === "receiptStatus") {
      const stream = streams.get(vault);
      // Only a session that opened its stream here (so this helper holds activation) looks for gone writers.
      if (stream && v.recordFile && ctx.exclusive()) {
        const hint = await readRecordHint(v.recordFile);
        const proofs = hint ? await goneWriterProofs(hint, hello.clientId, hello.writer, self, ctx.observer, ctx.now) : [];
        if (proofs.length > 0) {
          // Observations took time: the release needs the registered path and exclusive ownership now.
          await fence(v, id);
          requireExclusive(id, "after observing prior writers");
          called.engine = true;
          // A failed release leaves every guard in place; the status read below reports the marks either way.
          await receipts.releaseGoneWriters(v.vault.path, proofs, self.host);
        }
      }
      await fence(v, id);
      called.engine = true;
      const out = await receipts.status(v.vault.path, session(self, vault), request.want, { maxItems: MAX_WANT });
      if (isReceiptError(out)) throw fromEngine(out, id);
      const line = statusLine(id, out);
      if (!line) throw new LaneError("internal", "the receipt status would exceed the reply limit even as counts only", id);
      return { reply: line, close: false };
    }

    await fence(v, id);
    requireExclusive(id, "before this receipt");
    called.engine = true;
    const out = await receipts.apply(v.vault.path, session(self, vault), request);
    if (isReceiptError(out)) {
      const e = fromEngine(out, id);
      return { reply: errorLine(id, e), close: e.code === "superseded" };
    }
    return { reply: encodeLane({ id, ok: true, result: out }), close: false };
  }

  return {
    hello: { type: "hello", ok: true, protocol: 2, lane: "receipts", helperVersion: ctx.helperVersion, engineLevel: RECEIPT_ENGINE_LEVEL, capabilities: [RECEIPTS_CAPABILITY] },
    handle(line) {
      let id: number | null = null;
      const called = { engine: false };
      try {
        const request = parseLaneRequest(line);
        id = request.id;
        if (ctx.stopping()) throw new LaneError("stopping", "the helper is stopping", id);
        const v = ctx.vaults.get(request.vault);
        if (!v) throw new LaneError("unknown-vault", "no registered vault has this id", id);
        for (const path of requestPaths(request)) {
          if (!v.scope.isIncluded(path) || v.scope.isExcluded(path)) throw new LaneError("out-of-scope", "a path in this request is outside the vault's registered scope", id);
        }
        const receipts = v.receipts;
        if (!receipts) throw new LaneError("unavailable", "this vault's engine has no receipt API", id);
        const rid = id;
        // Registered before the first await, so a stop that starts now still waits for it.
        const work = ctx.track(request.vault, answer(rid, request, v, receipts, called));
        return work.catch((error: unknown) => ({ reply: errorLine(rid, toLaneError(error, rid, called.engine, request.method)), close: false }));
      } catch (error) {
        return Promise.resolve({ reply: errorLine(id, toLaneError(error, id, false, null)), close: false });
      }
    },
  };
}

/**
 * A thrown error as a lane error. Errors the session raised keep their code. Anything else is "internal"
 * when no engine call had started (nothing written), and "outcome-unknown" for an engine call that might
 * have written (openStream and sequenced receipts), so the client resends the identical request.
 */
function toLaneError(error: unknown, id: number | null, engineCalled: boolean, method: string | null): LaneError {
  if (error instanceof LaneError) return error.id === id ? error : new LaneError(error.code, error.message, id, error.stream);
  const text = error instanceof Error ? error.message.slice(0, 500) : "internal error";
  if (!engineCalled) return new LaneError("internal", `nothing was written: ${text}`, id);
  if (method === "receiptStatus") return new LaneError("internal", `the receipt status could not be read: ${text}`, id);
  return new LaneError("outcome-unknown", `the engine call did not answer cleanly; resend the identical request: ${text}`, id);
}
