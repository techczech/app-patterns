/**
 * Client for the receipts lane (protocol 2), separate from the protocol-1 client (client.ts).
 *
 * It owns no sequence numbers: every sequenced request carries the seq, body and acknowledgement the
 * caller's durable outbox assigned, and `openStream` returns the helper's durable stream identities and
 * counters for the caller to reconcile with. The client never resends anything: a request whose reply did
 * not arrive intact is reported as `outcome-unknown` (for openStream and sequenced receipts, which may
 * have been applied) and the caller resends the identical body with the same seq. Nothing it reports as
 * uncertain is an authorisation: only an exact applied result is.
 *
 * Bounds: one request on the wire at a time, at most MAX_QUEUED_REQUESTS waiting; a request line over
 * MAX_LINE_BYTES is refused before sending; replies over MAX_REPLY_BYTES close the connection. Every call
 * settles: with the checked reply; or rejects with a ReceiptsClientError after its timeout, a cancellation,
 * a malformed or unasked-for reply, or the connection closing. `sent` says whether its bytes were written.
 * A call's timeout and cancellation count from the call, waiting in the queue included: one that ends
 * while still queued is `not-sent` and leaves the request on the wire alone; one that ends after its bytes
 * were written closes the connection, so a late answer is never taken for another request.
 *
 * Identity is captured, never re-read from caller objects: the connection's client, clientId, clientEpoch
 * and writer when `connectReceipts` is called; each request body and its options when the call is made;
 * the stream identities and object format the connection's openStream returned when the request goes on
 * the wire. Replies are validated against exactly what was sent.
 */
import { connect, type Socket } from "node:net";
import { lstat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import type { WriterIncarnation } from "../receipt-ledger.ts";
import type { ReceiptResult } from "../receipt-ledger.ts";
import type { ReceiptStatusView, WantedDoc } from "../receipt-status.ts";
import type { OpenStreamRequest, OpenStreamResult, SeqRequest } from "../receipt-transitions.ts";
import { MAX_QUEUED_REQUESTS } from "./connection.ts";
import { lineSplitter, MAX_LINE_BYTES, MAX_REPLY_BYTES } from "./protocol.ts";
import {
  checkLaneResponse, checkOpenStreamResult, checkReceiptResult, checkReceiptStatusView, checkReceiptsHelloReply, encodeLane, RECEIPTS_CAPABILITY, RECEIPTS_PROTOCOL_VERSION,
  type LaneErrorBody,
} from "./receipt-protocol.ts";
import { plainAbsolutePath, resolveRuntimeFolder } from "./runtime-dir.ts";

/** A helper answer: the checked result, or the helper's error (no seq consumed unless it says outcome-unknown). */
export type ReceiptReply<T> = { ok: true; result: T } | { ok: false; error: LaneErrorBody };

export type ReceiptsClientErrorCode =
  /** Sent, and no intact reply: the request may have been applied. Resend the identical body. */
  | "outcome-unknown"
  /** Not sent (cancelled, queue full, too long, connection already closed): nothing reached the helper. */
  | "not-sent"
  /** A read-only request (receiptStatus) got no intact reply. */
  | "timeout" | "closed" | "bad-reply"
  /** The helper refused the receipts lane (an older helper, another engine level, or a refusal). */
  | "unavailable";

export class ReceiptsClientError extends Error {
  readonly code: ReceiptsClientErrorCode;
  readonly sent: boolean;
  constructor(code: ReceiptsClientErrorCode, message: string, sent: boolean) {
    super(message);
    this.name = "ReceiptsClientError";
    this.code = code;
    this.sent = sent;
  }
}

export interface RequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type SeqBody = SeqRequest extends infer R ? (R extends SeqRequest ? Omit<R, "id"> : never) : never;

export interface ReceiptsClient {
  readonly helperVersion: string;
  openStream(request: Omit<OpenStreamRequest, "id" | "method">, options?: RequestOptions): Promise<ReceiptReply<OpenStreamResult>>;
  send(request: SeqBody, options?: RequestOptions): Promise<ReceiptReply<ReceiptResult>>;
  status(vault: string, want: readonly WantedDoc[], options?: RequestOptions): Promise<ReceiptReply<ReceiptStatusView>>;
  /** The stream identities this connection's last successful openStream returned for `vault`. */
  stream(vault: string): { recordId: string; streamId: string } | null;
  /** Fulfils with the reason once the connection has closed for good. */
  readonly closed: Promise<Error>;
  close(): void;
}

export interface ConnectReceiptsOptions {
  client: string;
  clientId: string;
  clientEpoch: number;
  writer: WriterIncarnation | null;
  timeoutMs?: number;
}

interface Waiter {
  resolve: (line: string) => void;
  reject: (error: Error) => void;
}

/** What this connection's openStream returned for a vault, as validation needs it. */
interface KnownStream { recordId: string; streamId: string; objectFormat: "sha1" | "sha256" }

/** One queued call: `start` puts it on the wire; `drop` settles it unsent. */
interface Queued {
  start(): void;
  drop(error: ReceiptsClientError): void;
}

/** Connects to a helper's receipts lane; refuses a socket whose folder another user could control. */
export async function connectReceipts(socketPath: string, options: ConnectReceiptsOptions): Promise<ReceiptsClient> {
  // Captured before the first await: later changes to `options` change nothing this connection sends or checks.
  const identity = {
    client: options.client, clientId: options.clientId, clientEpoch: options.clientEpoch,
    writer: options.writer === null ? null : { ...options.writer }, timeoutMs: options.timeoutMs,
  };
  const paths = await resolveRuntimeFolder(dirname(plainAbsolutePath(socketPath, "socket path")), process.getuid?.(), basename(socketPath));
  const info = await lstat(paths.socket);
  if (!info.isSocket()) throw new ReceiptsClientError("unavailable", "the runtime folder holds no helper socket", false);
  const timeoutMs = identity.timeoutMs ?? 5_000;
  const socket: Socket = connect(paths.socket);
  let waiting: Waiter | null = null;
  let closedError: Error | null = null;
  let markClosed!: (error: Error) => void;
  const closed = new Promise<Error>((res) => { markClosed = res; });

  const queue: Queued[] = [];
  const fatal = (error: Error) => {
    if (!closedError) {
      closedError = error;
      markClosed(error);
    }
    const w = waiting;
    waiting = null;
    w?.reject(closedError);
    const unsent = new ReceiptsClientError("not-sent", `the connection closed before this request was sent: ${closedError.message}`, false);
    for (const q of queue.splice(0)) q.drop(unsent);
    socket.destroy();
  };
  const split = lineSplitter((line) => {
    const w = waiting;
    if (!w) return fatal(new ReceiptsClientError("bad-reply", "the helper sent a reply nobody asked for", true));
    waiting = null;
    w.resolve(line);
  }, MAX_REPLY_BYTES);
  socket.on("data", (chunk: Buffer) => {
    try {
      split(chunk);
    } catch (error) {
      fatal(new ReceiptsClientError("bad-reply", error instanceof Error ? error.message : "unreadable reply", true));
    }
  });
  socket.on("error", (error) => fatal(error));
  socket.on("close", () => fatal(new ReceiptsClientError("closed", "the helper closed the connection", true)));

  /** Writes `line` and waits for one reply line; any failure closes the connection. */
  const exchange = (line: string, ms: number, signal?: AbortSignal) =>
    new Promise<string>((resolve, reject) => {
      if (closedError) return reject(closedError);
      let timer: ReturnType<typeof setTimeout> | null = null;
      const onAbort = () => fail(new ReceiptsClientError("closed", "cancelled after sending; the connection was closed", true));
      const done = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const fail = (error: Error) => {
        done();
        if (waiting === entry) waiting = null;
        reject(error);
        // A late answer would otherwise be taken for the next request's.
        fatal(error);
      };
      const entry: Waiter = {
        resolve: (l) => { done(); resolve(l); },
        reject: (e) => { done(); reject(e); },
      };
      waiting = entry;
      timer = setTimeout(() => fail(new ReceiptsClientError("timeout", "the helper did not answer in time", true)), ms);
      signal?.addEventListener("abort", onAbort, { once: true });
      socket.write(line);
    });

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const hello = { type: "hello", protocol: RECEIPTS_PROTOCOL_VERSION, lane: "receipts", client: identity.client, clientId: identity.clientId, clientEpoch: identity.clientEpoch, writer: identity.writer, capabilities: [RECEIPTS_CAPABILITY] };
    let answer;
    try {
      answer = checkReceiptsHelloReply(await exchange(encodeLane(hello), timeoutMs));
    } catch (error) {
      if (error instanceof ReceiptsClientError) throw error;
      throw new ReceiptsClientError("bad-reply", error instanceof Error ? error.message : "unreadable hello answer", true);
    }
    if (!answer.ok) throw new ReceiptsClientError("unavailable", `the helper refused the receipts lane (${answer.code}): ${answer.message.slice(0, 200)}`, true);
    const helperVersion = answer.hello.helperVersion;

    const streams = new Map<string, KnownStream>();
    let nextId = 1;
    let active: Queued | null = null;
    const pump = () => {
      if (active || closedError) return;
      const next = queue.shift();
      if (!next) return;
      active = next;
      next.start();
    };

    /**
     * Queues one request. `uncertain` says whether a lost reply may hide an effect. `check` validates a
     * successful result against `at`, the stream this connection knew for `vault` when the request went
     * on the wire (and may record stream identities). The deadline and cancellation count from now.
     */
    const call = <T>(body: Record<string, unknown> & { vault: string }, uncertain: boolean, check: (result: unknown, at: KnownStream | null) => T, opts: RequestOptions = {}): Promise<ReceiptReply<T>> => {
      const ms = opts.timeoutMs ?? timeoutMs;
      const signal = opts.signal;
      const id = nextId++;
      const line = encodeLane({ id, ...body });
      const notSent = (message: string) => Promise.reject(new ReceiptsClientError("not-sent", message, false));
      if (closedError) return notSent(`the connection is closed: ${closedError.message}`);
      if (signal?.aborted) return notSent("cancelled before sending");
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) return notSent("the request line would exceed the protocol's size limit");
      if (queue.length + (active ? 1 : 0) >= MAX_QUEUED_REQUESTS) return notSent("too many requests are waiting on this connection");

      return new Promise<ReceiptReply<T>>((resolve, reject) => {
        let state: "queued" | "sent" | "settled" = "queued";
        let at: KnownStream | null = null;
        const settle = (outcome: () => void) => {
          if (state === "settled") return;
          const wasActive = active === entry;
          state = "settled";
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          const index = queue.indexOf(entry);
          if (index >= 0) queue.splice(index, 1);
          if (waiting === waiter) waiting = null;
          if (wasActive) active = null;
          outcome();
          if (wasActive) pump();
        };
        /** After the bytes were written: no intact reply. */
        const lost = (error: Error) => settle(() => {
          const text = error instanceof Error ? error.message : String(error);
          if (uncertain) reject(new ReceiptsClientError("outcome-unknown", `no intact reply; resend the identical request: ${text}`, true));
          else reject(error instanceof ReceiptsClientError ? error : new ReceiptsClientError("closed", text, true));
        });
        /** Deadline or cancellation: unsent while queued; after sending, the connection is closed. */
        const end = (unsentMessage: string, sentError: ReceiptsClientError) => {
          if (state === "queued") return settle(() => reject(new ReceiptsClientError("not-sent", unsentMessage, false)));
          // Closing first rejects this call through `waiter` and leaves no queued call to start on this
          // connection; a late answer would otherwise be taken for the next request's.
          if (state === "sent") fatal(sentError);
        };
        const onAbort = () => end("cancelled before sending", new ReceiptsClientError("closed", "cancelled after sending; the connection was closed", true));
        const waiter: Waiter = {
          resolve: (reply) => {
            if (state !== "sent") return;
            try {
              const response = checkLaneResponse(reply);
              if (response.id !== id) throw new Error(`the helper answered request ${String(response.id)} instead of ${id}`);
              const value: ReceiptReply<T> = response.ok ? { ok: true, result: check(response.result, at) } : { ok: false, error: response.error };
              settle(() => resolve(value));
            } catch (error) {
              const failure = new ReceiptsClientError(uncertain ? "outcome-unknown" : "bad-reply", `malformed reply: ${error instanceof Error ? error.message : String(error)}`, true);
              // Closed before this call settles, so no queued call starts on this connection.
              fatal(failure);
              settle(() => reject(failure));
            }
          },
          reject: (error) => lost(error),
        };
        const entry: Queued = {
          start: () => {
            if (state !== "queued") {
              // Settled while queued (settling removes it, so this is not expected): start the next one.
              active = null;
              return pump();
            }
            state = "sent";
            const known = streams.get(body.vault);
            at = known ? { ...known } : null;
            waiting = waiter;
            socket.write(line);
          },
          drop: (error) => settle(() => reject(error)),
        };
        const timer = setTimeout(() => end("the deadline passed before this request was sent", new ReceiptsClientError("timeout", "the helper did not answer in time", true)), ms);
        signal?.addEventListener("abort", onAbort, { once: true });
        queue.push(entry);
        pump();
      });
    };

    return {
      helperVersion,
      closed,
      stream: (vault) => {
        const known = streams.get(vault);
        return known ? { recordId: known.recordId, streamId: known.streamId } : null;
      },
      openStream: (request, opts) => {
        const full: OpenStreamRequest = { id: 0, method: "openStream", vault: request.vault, knownRecordId: request.knownRecordId, knownStreamId: request.knownStreamId, nextSeq: request.nextSeq, ackedThrough: request.ackedThrough };
        return call({ method: "openStream", vault: full.vault, knownRecordId: full.knownRecordId, knownStreamId: full.knownStreamId, nextSeq: full.nextSeq, ackedThrough: full.ackedThrough }, true, (result) => {
          const out = checkOpenStreamResult(result, full);
          streams.set(full.vault, { recordId: out.recordId, streamId: out.streamId, objectFormat: out.objectFormat });
          return out;
        }, captureOptions(opts));
      },
      send: (request, opts) => {
        // One copy, taken now: it is what is encoded and what the reply is checked against.
        const sent = structuredClone(request) as SeqBody;
        return call({ ...sent }, true, (result, at) => {
          if (!at) throw new Error("a receipt result arrived on a connection that has not opened this vault's stream");
          return checkReceiptResult(result, { id: 0, ...sent } as SeqRequest, at.recordId, identity.clientEpoch);
        }, captureOptions(opts));
      },
      status: (vault, want, opts) => {
        const copy = want.map((w) => ({ path: w.path, doc: { ...w.doc } }));
        return call({ method: "receiptStatus", vault, want: copy }, false, (result, at) => checkReceiptStatusView(result, copy, { clientId: identity.clientId, clientEpoch: identity.clientEpoch, stream: at }), captureOptions(opts));
      },
      close: () => {
        fatal(new ReceiptsClientError("closed", "the client closed the connection", true));
      },
    };
  } catch (error) {
    socket.destroy();
    if (error instanceof ReceiptsClientError) throw error;
    throw new ReceiptsClientError("unavailable", error instanceof Error ? error.message : String(error), false);
  }
}

/** A call's options as they are when the call is made. */
function captureOptions(opts: RequestOptions | undefined): RequestOptions {
  return opts ? { timeoutMs: opts.timeoutMs, signal: opts.signal } : {};
}
