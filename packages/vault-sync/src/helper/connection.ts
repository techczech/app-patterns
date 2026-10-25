/**
 * One accepted socket connection: hello, then requests answered one at a time in arrival order.
 *
 * A connection is a control connection (protocol 1: `status`, `syncNow`; protocol.ts) or a receipts
 * connection (protocol 2; receipt-protocol.ts, receipt-session.ts), decided by its hello. Protocol 1 is
 * answered exactly as before receipts existed (v1-golden.test.ts). Both kinds share the framing bounds:
 * a request line over MAX_LINE_BYTES or more than MAX_QUEUED_REQUESTS waiting requests closes the
 * connection, and a connection that has not said hello within HELLO_TIMEOUT_MS is closed.
 */
import type { Socket } from "node:net";
import { encode, lineSplitter, MAX_REPLY_BYTES, parseHello, parseRequest, PROTOCOL_VERSION, ProtocolError, type HelloResponse, type Request, type Response } from "./protocol.ts";
import { asksForReceiptsLane, encodeLane, LaneError, parseReceiptsHello, RECEIPTS_PROTOCOL_VERSION } from "./receipt-protocol.ts";
import { openReceiptLane, type ReceiptLane, type ReceiptLaneContext } from "./receipt-session.ts";
import { cycleReportView, VIEW_ITEM_LIMITS, vaultStatusView } from "./status-view.ts";
import type { Timers, VaultWorker } from "./vault-worker.ts";

export const MAX_QUEUED_REQUESTS = 8;
const HELLO_TIMEOUT_MS = 5_000;

export interface ConnectionContext {
  workers: Map<string, VaultWorker>;
  stopping: () => boolean;
  startedAt: number;
  timers: Timers;
  helperVersion: string;
  /** The receipts lane; null refuses protocol-2 hellos as protocol 1 always did. */
  receipts: ReceiptLaneContext | null;
}

export function serveConnection(socket: Socket, ctx: ConnectionContext): void {
  const { workers, stopping, startedAt, timers } = ctx;
  const HELPER_VERSION = ctx.helperVersion;
  let greeted = false;
  let finished = false;
  let busy = false;
  let lane: ReceiptLane | null = null;
  const queue: string[] = [];
  const send = (message: HelloResponse | Response) => {
    if (!socket.destroyed) socket.write(encode(message));
  };
  /** Sends a result in the largest view that fits a reply line; counts are exact in every view. */
  const reply = (id: number, build: (maxItems: number) => unknown) => {
    for (const maxItems of VIEW_ITEM_LIMITS) {
      const line = encode({ id, ok: true, result: build(maxItems) });
      if (Buffer.byteLength(line) <= MAX_REPLY_BYTES) {
        if (!socket.destroyed) socket.write(line);
        return;
      }
    }
    fail(new ProtocolError("internal", "the reply would exceed the protocol's size limit", id), id);
  };
  const helloTimer = timers.set(() => {
    if (!greeted) socket.destroy();
  }, HELLO_TIMEOUT_MS);
  socket.on("close", () => timers.clear(helloTimer));

  const fail = (error: unknown, id: number | null) => {
    const e = error instanceof ProtocolError ? error : new ProtocolError("internal", error instanceof Error ? error.message.slice(0, 500) : "internal error", id);
    send({ id: e.id ?? id, ok: false, error: { code: e.code, message: e.message } });
  };

  /** Answers a request with a builder for its reply at a given item limit. */
  async function handle(request: Request): Promise<(maxItems: number) => unknown> {
    if (request.method === "status") {
      let reports;
      if (request.vault !== undefined) {
        const worker = workers.get(request.vault);
        if (!worker) throw new ProtocolError("unknown-vault", "no registered vault has this id", request.id);
        reports = [await worker.status()];
      } else {
        reports = await Promise.all([...workers.values()].map((w) => w.status()));
      }
      const helper = helperInfo();
      return (maxItems) => ({ helper, vaults: reports.map((r) => vaultStatusView(r, maxItems)) });
    }
    if (stopping()) throw new ProtocolError("stopping", "the helper is stopping", request.id);
    const worker = workers.get(request.vault);
    if (!worker) throw new ProtocolError("unknown-vault", "no registered vault has this id", request.id);
    const report = await worker.syncNow();
    return (maxItems) => cycleReportView(report, maxItems);
  }
  // Protocol 1 sessions always report protocol 1, whatever else the helper speaks.
  const helperInfo = () => ({ protocol: PROTOCOL_VERSION, helperVersion: HELPER_VERSION, pid: process.pid, startedAt, stopping: stopping() });

  async function drain(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      while (queue.length && !socket.destroyed) {
        const line = queue.shift()!;
        if (lane) {
          let out: { reply: string; close: boolean };
          try {
            out = await lane.handle(line);
          } catch {
            // Not reached by design (the lane answers every line); an answer that cannot be tied to its request ends the connection.
            out = { reply: encodeLane({ id: null, ok: false, error: { code: "internal", message: "the receipts lane failed to answer" } }), close: true };
          }
          if (!socket.destroyed) socket.write(out.reply);
          if (out.close) finish();
          continue;
        }
        let id: number | null = null;
        try {
          const request = parseRequest(line);
          id = request.id;
          reply(id, await handle(request));
        } catch (error) {
          fail(error, error instanceof ProtocolError ? error.id : id);
        }
      }
    } finally {
      busy = false;
    }
  }

  const finish = () => {
    finished = true;
    queue.length = 0;
    socket.end();
  };
  /** A receipts hello: strict, answered in protocol 2's terms. */
  const greetReceipts = (line: string, receipts: ReceiptLaneContext) => {
    try {
      lane = openReceiptLane(parseReceiptsHello(line), receipts);
      greeted = true;
      timers.clear(helloTimer);
      if (!socket.destroyed) socket.write(encodeLane(lane.hello));
    } catch (error) {
      const e = error instanceof LaneError ? error : new LaneError("bad-request", "bad hello");
      if (!socket.destroyed) socket.write(encodeLane({ type: "hello", ok: false, protocol: RECEIPTS_PROTOCOL_VERSION, error: { code: e.code, message: e.message } }));
      finish();
    }
  };
  const split = lineSplitter((line) => {
    if (finished) return;
    if (!greeted) {
      if (ctx.receipts && asksForReceiptsLane(line)) return greetReceipts(line, ctx.receipts);
      try {
        const hello = parseHello(line);
        if (hello.protocol !== PROTOCOL_VERSION) {
          send({ type: "hello", ok: false, protocol: PROTOCOL_VERSION, error: { code: "protocol-mismatch", message: `this helper speaks protocol ${PROTOCOL_VERSION}` } });
          finish();
          return;
        }
        greeted = true;
        timers.clear(helloTimer);
        send({ type: "hello", ok: true, protocol: PROTOCOL_VERSION, helperVersion: HELPER_VERSION });
      } catch (error) {
        const e = error instanceof ProtocolError ? error : new ProtocolError("bad-request", "bad hello");
        send({ type: "hello", ok: false, protocol: PROTOCOL_VERSION, error: { code: e.code, message: e.message } });
        finish();
      }
      return;
    }
    if (queue.length >= MAX_QUEUED_REQUESTS) {
      fail(new ProtocolError("bad-request", "too many queued requests on this connection"), null);
      finish();
      return;
    }
    queue.push(line);
    void drain();
  });
  socket.on("data", (chunk: Buffer) => {
    if (finished) return;
    try {
      split(chunk);
    } catch (error) {
      fail(error, null);
      finish();
    }
  });
  socket.on("error", () => socket.destroy());
}
