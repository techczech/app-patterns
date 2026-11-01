/**
 * Protocol 1 transcripts, byte for byte. The expected strings were recorded from the protocol-1-only
 * server (package 0.1.0, before receipts lanes existed); the server must still answer a protocol-1 client
 * with exactly these bytes. Only the helper version and this process's id are placeholders.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileScope } from "../scope.ts";
import { MAX_LINE_BYTES } from "./protocol.ts";
import type { ReceiptLaneContext } from "./receipt-session.ts";
import { serveConnection } from "./connection.ts";
import { HELPER_VERSION } from "./server.ts";
import { systemTimers, type CycleReport, type VaultStatusReport, type VaultWorker } from "./vault-worker.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function statusReport(vault: string): VaultStatusReport {
  return {
    vault, summary: "unprotected", uncertainty: ["edits after the last capture are unknown"],
    helper: { state: "idle", cycleStartedAt: null, nextDueAt: 1_800_000_060_000, lastCycle: null },
    fresh: true, engineObservedAt: 1_800_000_000_500,
    engine: {
      machineId: "m", checkoutId: "c", protectionAgeSeconds: 12, oldestUnprotectedEdit: 1_800_000_000_000, lastVerifiedSnapshot: null, lastVerifiedAt: null, protectedThrough: null,
      latestSnapshot: null, latestRef: null, lastPushed: null, pending: ["notes/a.md", "notes/b.md"], unlistedFolders: [], unflushedEditSince: null, writing: [], lastError: null,
      recoveredFromDamagedRecord: false, repositoryHooksNotRun: [], enabled: true, remote: "origin", block: null,
    },
    statusError: null,
  };
}

function cycleReport(vault: string): CycleReport {
  return {
    vault, reason: "syncNow", startedAt: 1_800_000_000_100, finishedAt: 1_800_000_000_900, outcome: "no-snapshot",
    capture: { snapshot: null, committed: false, startedAt: 1_800_000_000_100, changed: 0, pending: ["notes/a.md"], skipped: 0 },
    push: null, verify: null, block: null, error: null,
  };
}

function worker(id: string, syncNow: () => Promise<CycleReport> = async () => cycleReport(id)): VaultWorker {
  return { id, start: () => undefined, syncNow, status: async () => statusReport(id), stop: async () => undefined, unsettled: () => [] };
}

/** A receipts lane is offered alongside, as in the helper; protocol-1 connections must not notice it. */
function receiptsContext(workers: Map<string, VaultWorker>): ReceiptLaneContext {
  const vaults = new Map([...workers.keys()].map((id) => [id, { vault: { id, path: "/nonexistent", scope: { include: ["notes"] }, remote: "origin" }, scope: compileScope({ include: ["notes"] }), receipts: null, recordFile: null }]));
  return {
    vaults, helperVersion: HELPER_VERSION, identity: async () => null, exclusive: () => false, stopping: () => false, priorShutdown: null,
    observer: { startTime: async () => null, observe: async () => "unknown" }, track: (_vault, work) => work, now: () => 0,
  };
}

/** A connection server over a private local socket, with fake workers. */
async function serve(workers: VaultWorker[], stopping = () => false): Promise<string> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "s")));
  const path = join(dir, "h");
  const map = new Map(workers.map((w) => [w.id, w]));
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    serveConnection(socket, { workers: map, stopping, startedAt: 1_800_000_000_000, timers: systemTimers, helperVersion: HELPER_VERSION, receipts: receiptsContext(map) });
  });
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(path, res);
  });
  cleanups.push(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((res) => server.close(() => res()));
    rmSync(dir, { recursive: true, force: true });
  });
  return path;
}

/** Writes `payload`, then collects every byte until `replies` lines arrived (or the peer closed) plus a short quiet period. */
function exchange(path: string, payload: string, replies: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let data = "";
    let quiet: ReturnType<typeof setTimeout> | null = null;
    const done = () => {
      if (quiet) clearTimeout(quiet);
      clearTimeout(bound);
      socket.destroy();
      resolve(data);
    };
    const bound = setTimeout(done, 3_000);
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (c) => {
      data += c.toString();
      if (data.split("\n").length - 1 >= replies && !quiet) quiet = setTimeout(done, 40);
    });
    socket.on("error", reject);
    socket.on("close", done);
  });
}

const line = (v: unknown) => `${JSON.stringify(v)}\n`;
const HELLO = line({ type: "hello", protocol: 1, client: "golden" });
const normalise = (bytes: string) => bytes.split(JSON.stringify(HELPER_VERSION)).join('"<HELPER_VERSION>"').split(`"pid":${process.pid},`).join('"pid":"<PID>",');

const GOLDEN = {
  hello: "{\"type\":\"hello\",\"ok\":true,\"protocol\":1,\"helperVersion\":\"<HELPER_VERSION>\"}\n",
  statusAll: "{\"type\":\"hello\",\"ok\":true,\"protocol\":1,\"helperVersion\":\"<HELPER_VERSION>\"}\n{\"id\":1,\"ok\":true,\"result\":{\"helper\":{\"protocol\":1,\"helperVersion\":\"<HELPER_VERSION>\",\"pid\":\"<PID>\",\"startedAt\":1800000000000,\"stopping\":false},\"vaults\":[{\"vault\":\"v\",\"summary\":\"unprotected\",\"uncertainty\":[\"edits after the last capture are unknown\"],\"helper\":{\"state\":\"idle\",\"cycleStartedAt\":null,\"nextDueAt\":1800000060000,\"lastCycle\":null},\"fresh\":true,\"engineObservedAt\":1800000000500,\"engine\":{\"machineId\":\"m\",\"checkoutId\":\"c\",\"protectionAgeSeconds\":12,\"oldestUnprotectedEdit\":1800000000000,\"lastVerifiedSnapshot\":null,\"lastVerifiedAt\":null,\"protectedThrough\":null,\"latestSnapshot\":null,\"latestRef\":null,\"lastPushed\":null,\"pending\":{\"count\":2,\"items\":[\"notes/a.md\",\"notes/b.md\"],\"omitted\":0},\"unlistedFolders\":{\"count\":0,\"items\":[],\"omitted\":0},\"unflushedEditSince\":null,\"writing\":{\"count\":0,\"items\":[],\"omitted\":0},\"lastError\":null,\"recoveredFromDamagedRecord\":false,\"repositoryHooksNotRun\":{\"count\":0,\"items\":[],\"omitted\":0},\"enabled\":true,\"remote\":\"origin\",\"block\":null},\"statusError\":null},{\"vault\":\"w\",\"summary\":\"unprotected\",\"uncertainty\":[\"edits after the last capture are unknown\"],\"helper\":{\"state\":\"idle\",\"cycleStartedAt\":null,\"nextDueAt\":1800000060000,\"lastCycle\":null},\"fresh\":true,\"engineObservedAt\":1800000000500,\"engine\":{\"machineId\":\"m\",\"checkoutId\":\"c\",\"protectionAgeSeconds\":12,\"oldestUnprotectedEdit\":1800000000000,\"lastVerifiedSnapshot\":null,\"lastVerifiedAt\":null,\"protectedThrough\":null,\"latestSnapshot\":null,\"latestRef\":null,\"lastPushed\":null,\"pending\":{\"count\":2,\"items\":[\"notes/a.md\",\"notes/b.md\"],\"omitted\":0},\"unlistedFolders\":{\"count\":0,\"items\":[],\"omitted\":0},\"unflushedEditSince\":null,\"writing\":{\"count\":0,\"items\":[],\"omitted\":0},\"lastError\":null,\"recoveredFromDamagedRecord\":false,\"repositoryHooksNotRun\":{\"count\":0,\"items\":[],\"omitted\":0},\"enabled\":true,\"remote\":\"origin\",\"block\":null},\"statusError\":null}]}}\n",
  requests: "{\"type\":\"hello\",\"ok\":true,\"protocol\":1,\"helperVersion\":\"<HELPER_VERSION>\"}\n{\"id\":2,\"ok\":true,\"result\":{\"helper\":{\"protocol\":1,\"helperVersion\":\"<HELPER_VERSION>\",\"pid\":\"<PID>\",\"startedAt\":1800000000000,\"stopping\":false},\"vaults\":[{\"vault\":\"v\",\"summary\":\"unprotected\",\"uncertainty\":[\"edits after the last capture are unknown\"],\"helper\":{\"state\":\"idle\",\"cycleStartedAt\":null,\"nextDueAt\":1800000060000,\"lastCycle\":null},\"fresh\":true,\"engineObservedAt\":1800000000500,\"engine\":{\"machineId\":\"m\",\"checkoutId\":\"c\",\"protectionAgeSeconds\":12,\"oldestUnprotectedEdit\":1800000000000,\"lastVerifiedSnapshot\":null,\"lastVerifiedAt\":null,\"protectedThrough\":null,\"latestSnapshot\":null,\"latestRef\":null,\"lastPushed\":null,\"pending\":{\"count\":2,\"items\":[\"notes/a.md\",\"notes/b.md\"],\"omitted\":0},\"unlistedFolders\":{\"count\":0,\"items\":[],\"omitted\":0},\"unflushedEditSince\":null,\"writing\":{\"count\":0,\"items\":[],\"omitted\":0},\"lastError\":null,\"recoveredFromDamagedRecord\":false,\"repositoryHooksNotRun\":{\"count\":0,\"items\":[],\"omitted\":0},\"enabled\":true,\"remote\":\"origin\",\"block\":null},\"statusError\":null}]}}\n{\"id\":3,\"ok\":true,\"result\":{\"vault\":\"v\",\"reason\":\"syncNow\",\"startedAt\":1800000000100,\"finishedAt\":1800000000900,\"outcome\":\"no-snapshot\",\"capture\":{\"snapshot\":null,\"committed\":false,\"startedAt\":1800000000100,\"changed\":0,\"pending\":{\"count\":1,\"items\":[\"notes/a.md\"],\"omitted\":0},\"skipped\":0},\"push\":null,\"verify\":null,\"block\":null,\"error\":null}}\n{\"id\":4,\"ok\":false,\"error\":{\"code\":\"unknown-vault\",\"message\":\"no registered vault has this id\"}}\n{\"id\":5,\"ok\":false,\"error\":{\"code\":\"bad-request\",\"message\":\"unexpected field \\\"path\\\"\"}}\n{\"id\":6,\"ok\":false,\"error\":{\"code\":\"bad-request\",\"message\":\"syncNow needs a registered vault id\"}}\n{\"id\":null,\"ok\":false,\"error\":{\"code\":\"bad-request\",\"message\":\"request needs a nonnegative integer id\"}}\n{\"id\":null,\"ok\":false,\"error\":{\"code\":\"bad-request\",\"message\":\"message is not JSON\"}}\n{\"id\":7,\"ok\":false,\"error\":{\"code\":\"unknown-method\",\"message\":\"unknown method\"}}\n",
  reserved: "{\"type\":\"hello\",\"ok\":true,\"protocol\":1,\"helperVersion\":\"<HELPER_VERSION>\"}\n{\"id\":10,\"ok\":false,\"error\":{\"code\":\"not-available\",\"message\":\"noteEdit is reserved for app adapters and not available in protocol 1\"}}\n{\"id\":11,\"ok\":false,\"error\":{\"code\":\"not-available\",\"message\":\"noteWriteStart is reserved for app adapters and not available in protocol 1\"}}\n{\"id\":12,\"ok\":false,\"error\":{\"code\":\"not-available\",\"message\":\"noteFlush is reserved for app adapters and not available in protocol 1\"}}\n",
  receiptNamesOnV1: "{\"type\":\"hello\",\"ok\":true,\"protocol\":1,\"helperVersion\":\"<HELPER_VERSION>\"}\n{\"id\":20,\"ok\":false,\"error\":{\"code\":\"unknown-method\",\"message\":\"unknown method\"}}\n{\"id\":21,\"ok\":false,\"error\":{\"code\":\"unknown-method\",\"message\":\"unknown method\"}}\n{\"id\":22,\"ok\":false,\"error\":{\"code\":\"unknown-method\",\"message\":\"unknown method\"}}\n{\"id\":23,\"ok\":false,\"error\":{\"code\":\"unknown-method\",\"message\":\"unknown method\"}}\n",
  beforeHello: "{\"type\":\"hello\",\"ok\":false,\"protocol\":1,\"error\":{\"code\":\"hello-required\",\"message\":\"the first message must be hello\"}}\n",
  helloRefusals: "{\"type\":\"hello\",\"ok\":false,\"protocol\":1,\"error\":{\"code\":\"protocol-mismatch\",\"message\":\"this helper speaks protocol 1\"}}\n|{\"type\":\"hello\",\"ok\":false,\"protocol\":1,\"error\":{\"code\":\"protocol-mismatch\",\"message\":\"this helper speaks protocol 1\"}}\n|{\"type\":\"hello\",\"ok\":false,\"protocol\":1,\"error\":{\"code\":\"bad-request\",\"message\":\"hello needs an integer protocol\"}}\n|{\"type\":\"hello\",\"ok\":false,\"protocol\":1,\"error\":{\"code\":\"bad-request\",\"message\":\"hello needs a printable client name\"}}\n|{\"type\":\"hello\",\"ok\":true,\"protocol\":1,\"helperVersion\":\"<HELPER_VERSION>\"}\n",
  longLine: "{\"type\":\"hello\",\"ok\":true,\"protocol\":1,\"helperVersion\":\"<HELPER_VERSION>\"}\n{\"id\":null,\"ok\":false,\"error\":{\"code\":\"bad-request\",\"message\":\"line too long\"}}\n",
  queue: "{\"type\":\"hello\",\"ok\":true,\"protocol\":1,\"helperVersion\":\"<HELPER_VERSION>\"}\n{\"id\":null,\"ok\":false,\"error\":{\"code\":\"bad-request\",\"message\":\"too many queued requests on this connection\"}}\n",
  stopping: "{\"type\":\"hello\",\"ok\":true,\"protocol\":1,\"helperVersion\":\"<HELPER_VERSION>\"}\n{\"id\":40,\"ok\":false,\"error\":{\"code\":\"stopping\",\"message\":\"the helper is stopping\"}}\n{\"id\":41,\"ok\":true,\"result\":{\"helper\":{\"protocol\":1,\"helperVersion\":\"<HELPER_VERSION>\",\"pid\":\"<PID>\",\"startedAt\":1800000000000,\"stopping\":true},\"vaults\":[{\"vault\":\"v\",\"summary\":\"unprotected\",\"uncertainty\":[\"edits after the last capture are unknown\"],\"helper\":{\"state\":\"idle\",\"cycleStartedAt\":null,\"nextDueAt\":1800000060000,\"lastCycle\":null},\"fresh\":true,\"engineObservedAt\":1800000000500,\"engine\":{\"machineId\":\"m\",\"checkoutId\":\"c\",\"protectionAgeSeconds\":12,\"oldestUnprotectedEdit\":1800000000000,\"lastVerifiedSnapshot\":null,\"lastVerifiedAt\":null,\"protectedThrough\":null,\"latestSnapshot\":null,\"latestRef\":null,\"lastPushed\":null,\"pending\":{\"count\":2,\"items\":[\"notes/a.md\",\"notes/b.md\"],\"omitted\":0},\"unlistedFolders\":{\"count\":0,\"items\":[],\"omitted\":0},\"unflushedEditSince\":null,\"writing\":{\"count\":0,\"items\":[],\"omitted\":0},\"lastError\":null,\"recoveredFromDamagedRecord\":false,\"repositoryHooksNotRun\":{\"count\":0,\"items\":[],\"omitted\":0},\"enabled\":true,\"remote\":\"origin\",\"block\":null},\"statusError\":null}]}}\n",
};

describe("protocol 1 transcripts are byte-identical", () => {
  test("hello and status of every vault", async () => {
    const path = await serve([worker("v"), worker("w")]);
    expect(normalise(await exchange(path, HELLO, 1))).toBe(GOLDEN.hello);
    expect(normalise(await exchange(path, HELLO + line({ id: 1, method: "status" }), 2))).toBe(GOLDEN.statusAll);
  });

  test("status of one vault, syncNow, unknown vault, unexpected fields, bad ids, non-JSON", async () => {
    const path = await serve([worker("v")]);
    const payload = HELLO + [
      line({ id: 2, method: "status", vault: "v" }),
      line({ id: 3, method: "syncNow", vault: "v" }),
      line({ id: 4, method: "syncNow", vault: "nope" }),
      line({ id: 5, method: "status", vault: "v", path: "/" }),
      line({ id: 6, method: "syncNow", vault: "../v" }),
      line({ method: "status" }),
      "not json\n",
      line({ id: 7, method: "run", vault: "v" }),
    ].join("");
    expect(normalise(await exchange(path, payload, 9))).toBe(GOLDEN.requests);
  });

  test("reserved receipt names and protocol-2 method names on a protocol-1 connection", async () => {
    const path = await serve([worker("v")]);
    const reserved = HELLO + ["noteEdit", "noteWriteStart", "noteFlush"].map((method, i) => line({ id: 10 + i, method, vault: "v", path: "notes/a.md" })).join("");
    expect(normalise(await exchange(path, reserved, 4))).toBe(GOLDEN.reserved);
    const names = HELLO + ["openStream", "noteWriteAbandon", "adopt", "receiptStatus"].map((method, i) => line({ id: 20 + i, method, vault: "v" })).join("");
    expect(normalise(await exchange(path, names, 5))).toBe(GOLDEN.receiptNamesOnV1);
  });

  test("request before hello; refused hellos", async () => {
    const path = await serve([worker("v")]);
    expect(normalise(await exchange(path, line({ id: 1, method: "status" }), 1))).toBe(GOLDEN.beforeHello);
    const refusals = [
      await exchange(path, line({ type: "hello", protocol: 2, client: "old-app" }), 1),
      await exchange(path, line({ type: "hello", protocol: 3, client: "x" }), 1),
      await exchange(path, line({ type: "hello", protocol: "1", client: "x" }), 1),
      await exchange(path, line({ type: "hello", protocol: 1, client: "" }), 1),
      await exchange(path, line({ type: "hello", protocol: 1, client: "x", lane: "control", extra: true }), 1),
    ].map(normalise).join("|");
    expect(refusals).toBe(GOLDEN.helloRefusals);
  });

  test("an endless line and too many queued requests close the connection", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const path = await serve([worker("v", async () => { await held; return cycleReport("v"); })]);
    expect(normalise(await exchange(path, HELLO + "x".repeat(MAX_LINE_BYTES + 10), 2))).toBe(GOLDEN.longLine);
    const flood = HELLO + Array.from({ length: 10 }, (_, i) => line({ id: 30 + i, method: "syncNow", vault: "v" })).join("");
    expect(normalise(await exchange(path, flood, 2))).toBe(GOLDEN.queue);
    release();
  });

  test("a stopping helper refuses syncNow and still answers status", async () => {
    const path = await serve([worker("v")], () => true);
    expect(normalise(await exchange(path, HELLO + line({ id: 40, method: "syncNow", vault: "v" }) + line({ id: 41, method: "status", vault: "v" }), 3))).toBe(GOLDEN.stopping);
  });
});
