/**
 * Local helper protocol, version 1: newline-delimited JSON over a Unix socket.
 *
 * A connection starts with `hello`; the helper answers with its protocol version or refuses a client
 * that asks for another one. After that a client sends requests with a numeric `id` and gets exactly one
 * response with the same id. Requests name vaults only by their registered id, never by path, scope or
 * remote, so a client can reach nothing the helper's configuration did not register.
 *
 * Methods in version 1: `status` and `syncNow`. The writer-receipt methods (`noteEdit`,
 * `noteWriteStart`, `noteFlush`) are reserved names; version 1 refuses them with `not-available`. Receipts
 * travel only on a separate protocol-2 receipts connection (receipt-protocol.ts); a protocol-1 connection
 * answers exactly as it did before that existed.
 *
 * Size: a request line is at most MAX_LINE_BYTES; a reply line at most MAX_REPLY_BYTES. The helper keeps
 * its replies inside that bound by listing at most a sample of each path list next to its exact count and
 * the number omitted (see status-view.ts); counts, summaries and uncertainty are never shortened.
 *
 * What each side checks:
 * - Helper, hello: `type`, an integer `protocol` and a printable `client` are required; other hello fields
 *   are ignored. A bad hello or another protocol version is answered with a refusal and the connection closes.
 * - Helper, requests: an unknown field, a wrong type, an unknown method or vault is answered with an error
 *   for that request id; the connection stays open. Too many queued requests or an over-long line close it.
 * - Client, every reply: an unknown field, a wrong type, a reply to another request or a hello for another
 *   protocol version closes the connection and fails the request.
 */

export const PROTOCOL_VERSION = 1;
/** Longest request line, in bytes, the helper accepts before it closes the connection. */
export const MAX_LINE_BYTES = 64 * 1024;
/** Longest reply line, in bytes, the helper sends and the client accepts. */
export const MAX_REPLY_BYTES = 1024 * 1024;

export const RESERVED_RECEIPT_METHODS = ["noteEdit", "noteWriteStart", "noteFlush"] as const;

export type ErrorCode =
  | "bad-request"
  | "protocol-mismatch"
  | "hello-required"
  | "unknown-method"
  | "unknown-vault"
  | "not-available"
  | "stopping"
  | "internal";

export interface HelloRequest {
  type: "hello";
  protocol: number;
  client: string;
}

export type Request =
  | { id: number; method: "status"; vault?: string }
  | { id: number; method: "syncNow"; vault: string };

export type Response =
  | { id: number; ok: true; result: unknown }
  | { id: number | null; ok: false; error: { code: ErrorCode; message: string } };

export type HelloResponse =
  | { type: "hello"; ok: true; protocol: number; helperVersion: string }
  | { type: "hello"; ok: false; protocol: number; error: { code: ErrorCode; message: string } };

const VAULT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CLIENT = /^[\x20-\x7e]{1,100}$/;
const ERROR_CODES: readonly ErrorCode[] = ["bad-request", "protocol-mismatch", "hello-required", "unknown-method", "unknown-vault", "not-available", "stopping", "internal"];
const MAX_ERROR_MESSAGE = 2_000;

export function isVaultId(value: unknown): value is string {
  return typeof value === "string" && VAULT_ID.test(value);
}

export class ProtocolError extends Error {
  readonly code: ErrorCode;
  readonly id: number | null;
  constructor(code: ErrorCode, message: string, id: number | null = null) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.id = id;
  }
}

function object(line: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new ProtocolError("bad-request", "message is not JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProtocolError("bad-request", "message must be a JSON object");
  return value as Record<string, unknown>;
}

export function parseHello(line: string): HelloRequest {
  const v = object(line);
  if (v.type !== "hello") throw new ProtocolError("hello-required", "the first message must be hello");
  if (!Number.isSafeInteger(v.protocol)) throw new ProtocolError("bad-request", "hello needs an integer protocol");
  if (!CLIENT.test(String(v.client ?? ""))) throw new ProtocolError("bad-request", "hello needs a printable client name");
  return { type: "hello", protocol: v.protocol as number, client: v.client as string };
}

export function parseRequest(line: string): Request {
  const v = object(line);
  const id = v.id;
  if (!Number.isSafeInteger(id) || (id as number) < 0) throw new ProtocolError("bad-request", "request needs a nonnegative integer id");
  const rid = id as number;
  const allowed = (keys: string[]) => {
    for (const key of Object.keys(v)) if (!keys.includes(key)) throw new ProtocolError("bad-request", `unexpected field ${JSON.stringify(key).slice(0, 40)}`, rid);
  };
  if (v.method === "status") {
    allowed(["id", "method", "vault"]);
    if (v.vault !== undefined && !isVaultId(v.vault)) throw new ProtocolError("bad-request", "vault must be a registered vault id", rid);
    return v.vault === undefined ? { id: rid, method: "status" } : { id: rid, method: "status", vault: v.vault as string };
  }
  if (v.method === "syncNow") {
    allowed(["id", "method", "vault"]);
    if (!isVaultId(v.vault)) throw new ProtocolError("bad-request", "syncNow needs a registered vault id", rid);
    return { id: rid, method: "syncNow", vault: v.vault as string };
  }
  if (typeof v.method === "string" && (RESERVED_RECEIPT_METHODS as readonly string[]).includes(v.method)) {
    throw new ProtocolError("not-available", `${v.method} is reserved for app adapters and not available in protocol ${PROTOCOL_VERSION}`, rid);
  }
  throw new ProtocolError("unknown-method", "unknown method", rid);
}

function onlyKeys(v: Record<string, unknown>, keys: string[], what: string): void {
  for (const key of Object.keys(v)) if (!keys.includes(key)) throw new ProtocolError("bad-request", `${what} has unexpected field ${JSON.stringify(key).slice(0, 40)}`);
}

function errorBody(value: unknown): { code: ErrorCode; message: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProtocolError("bad-request", "error must be an object");
  const e = value as Record<string, unknown>;
  onlyKeys(e, ["code", "message"], "error");
  if (!ERROR_CODES.includes(e.code as ErrorCode)) throw new ProtocolError("bad-request", "error has an unknown code");
  if (typeof e.message !== "string" || e.message.length > MAX_ERROR_MESSAGE) throw new ProtocolError("bad-request", "error needs a short message");
  return { code: e.code as ErrorCode, message: e.message };
}

/** Parses the helper's hello answer. Throws ProtocolError for anything but a complete, well-formed answer. */
export function parseHelloResponse(line: string): HelloResponse {
  const v = object(line);
  if (v.type !== "hello" || typeof v.ok !== "boolean" || !Number.isSafeInteger(v.protocol)) throw new ProtocolError("bad-request", "not a hello answer");
  if (v.ok) {
    onlyKeys(v, ["type", "ok", "protocol", "helperVersion"], "hello answer");
    if (typeof v.helperVersion !== "string" || !CLIENT.test(v.helperVersion)) throw new ProtocolError("bad-request", "hello answer needs a printable helper version");
    return { type: "hello", ok: true, protocol: v.protocol as number, helperVersion: v.helperVersion };
  }
  onlyKeys(v, ["type", "ok", "protocol", "error"], "hello answer");
  return { type: "hello", ok: false, protocol: v.protocol as number, error: errorBody(v.error) };
}

/** Parses a response envelope. The result itself is the method's to check; the id is the caller's to correlate. */
export function parseResponse(line: string): Response {
  const v = object(line);
  const id = v.id;
  if (id !== null && (!Number.isSafeInteger(id) || (id as number) < 0)) throw new ProtocolError("bad-request", "response needs a nonnegative integer id or null");
  if (v.ok === true) {
    onlyKeys(v, ["id", "ok", "result"], "response");
    if (id === null || !("result" in v)) throw new ProtocolError("bad-request", "a successful response needs its request id and a result");
    return { id: id as number, ok: true, result: v.result };
  }
  if (v.ok === false) {
    onlyKeys(v, ["id", "ok", "error"], "response");
    return { id: id as number | null, ok: false, error: errorBody(v.error) };
  }
  throw new ProtocolError("bad-request", "response needs ok true or false");
}

export function encode(message: HelloRequest | HelloResponse | Request | Response): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Splits a byte stream into lines. Calls `onLine` per complete line; throws ProtocolError once buffered
 * data exceeds `maxBytes` without a newline, so a peer cannot make the reader buffer without bound.
 */
export function lineSplitter(onLine: (line: string) => void, maxBytes = MAX_LINE_BYTES): (chunk: Buffer) => void {
  let pending: Buffer = Buffer.alloc(0);
  return (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    for (;;) {
      const end = pending.indexOf(0x0a);
      if (end < 0) break;
      if (end > maxBytes) throw new ProtocolError("bad-request", "line too long");
      const line = pending.subarray(0, end).toString("utf8");
      pending = pending.subarray(end + 1);
      if (line.trim() !== "") onLine(line);
    }
    if (pending.length > maxBytes) throw new ProtocolError("bad-request", "line too long");
  };
}
