/**
 * Client for the helper socket: checks the socket's folder, says hello, then sends requests one at a time.
 *
 * Every reply is checked in full before it is used: the hello must be a well-formed answer for the
 * protocol this client asked for, and each response a well-formed envelope carrying the id of the request
 * it answers. Anything else (bad JSON, unknown fields, another protocol, another id, a line nobody asked
 * for, a line over MAX_REPLY_BYTES) closes the connection and fails the request. A failed connect never
 * leaves its socket open.
 */
import { connect, type Socket } from "node:net";
import { lstat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { encode, lineSplitter, MAX_REPLY_BYTES, parseHelloResponse, parseResponse, PROTOCOL_VERSION, type Response } from "./protocol.ts";
import { plainAbsolutePath, resolveRuntimeFolder } from "./runtime-dir.ts";

export interface HelperClient {
  readonly helperVersion: string;
  request(method: "status", params?: { vault?: string }, timeoutMs?: number): Promise<Response>;
  request(method: "syncNow", params: { vault: string }, timeoutMs?: number): Promise<Response>;
  /** Sends an arbitrary request object; for protocol tests. The reply must carry its `id` (or null for an error). */
  raw(message: Record<string, unknown>, timeoutMs?: number): Promise<Response>;
  close(): void;
}

export class HelperClientError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HelperClientError";
    this.code = code;
  }
}

const badReply = (message: string) => new HelperClientError("bad-reply", message);

/** Connects to a helper. Refuses a socket whose folder another user could control, so a client never talks to an impostor. */
export async function connectHelper(socketPath: string, options: { client: string; protocol?: number; timeoutMs?: number }): Promise<HelperClient> {
  // Resolve the folder the same way the helper does and connect through its real path.
  const paths = await resolveRuntimeFolder(dirname(plainAbsolutePath(socketPath, "socket path")), process.getuid?.(), basename(socketPath));
  const target = paths.socket;
  const info = await lstat(target);
  if (!info.isSocket()) throw new HelperClientError("not-a-socket", "the runtime folder holds no helper socket");
  const timeoutMs = options.timeoutMs ?? 5_000;
  const protocol = options.protocol ?? PROTOCOL_VERSION;
  const socket: Socket = connect(target);
  const waiting: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];
  let closedError: Error | null = null;

  /** Ends the connection for good and fails everything waiting on it. */
  const fatal = (error: Error) => {
    closedError ??= error;
    for (const w of waiting.splice(0)) w.reject(closedError);
    socket.destroy();
  };
  const split = lineSplitter((line) => {
    const w = waiting.shift();
    if (!w) return fatal(badReply("the helper sent a reply nobody asked for"));
    w.resolve(line);
  }, MAX_REPLY_BYTES);
  socket.on("data", (chunk: Buffer) => {
    try {
      split(chunk);
    } catch (error) {
      fatal(badReply(error instanceof Error ? error.message : "unreadable reply"));
    }
  });
  socket.on("error", (error) => fatal(error));
  socket.on("close", () => fatal(new HelperClientError("closed", "the helper closed the connection")));

  const next = (ms: number) =>
    new Promise<string>((resolve, reject) => {
      if (closedError) return reject(closedError);
      const timer = setTimeout(() => {
        const i = waiting.indexOf(entry);
        if (i >= 0) waiting.splice(i, 1);
        reject(new HelperClientError("timeout", "the helper did not answer in time"));
        // A late answer would otherwise be taken for the next request's.
        fatal(new HelperClientError("timeout", "the helper did not answer in time"));
      }, ms);
      const entry = {
        resolve: (line: string) => { clearTimeout(timer); resolve(line); },
        reject: (error: Error) => { clearTimeout(timer); reject(error); },
      };
      waiting.push(entry);
    });

  /** Parses a line with `parse`; a failure closes the connection. */
  const checked = <T>(line: string, parse: (line: string) => T): T => {
    try {
      return parse(line);
    } catch (error) {
      const failure = badReply(error instanceof Error ? error.message : "unreadable reply");
      fatal(failure);
      throw failure;
    }
  };

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(encode({ type: "hello", protocol, client: options.client }));
    const hello = checked(await next(timeoutMs), parseHelloResponse);
    if (!hello.ok) throw new HelperClientError(hello.error.code, hello.error.message);
    if (hello.protocol !== protocol) throw badReply(`the helper answered for protocol ${hello.protocol}, not ${protocol}`);

    let nextId = 1;
    let chain: Promise<unknown> = Promise.resolve();
    const send = (message: Record<string, unknown>, ms: number): Promise<Response> => {
      const expected = Number.isSafeInteger(message.id) && (message.id as number) >= 0 ? (message.id as number) : null;
      const run = chain.then(async () => {
        if (closedError) throw closedError;
        socket.write(`${JSON.stringify(message)}\n`);
        const response = checked(await next(ms), parseResponse);
        if (response.id === expected) return response;
        // An error the helper could not tie to a request ends the connection; it is not this request's answer.
        if (response.id === null && !response.ok) {
          const failure = new HelperClientError(response.error.code, response.error.message);
          fatal(failure);
          throw failure;
        }
        const failure = badReply(`the helper answered request ${String(response.id)} instead of ${String(expected)}`);
        fatal(failure);
        throw failure;
      });
      chain = run.catch(() => undefined);
      return run;
    };
    return {
      helperVersion: hello.helperVersion,
      request: (method: "status" | "syncNow", params: { vault?: string } = {}, ms = timeoutMs) => send({ id: nextId++, method, ...params }, ms),
      raw: (message, ms = timeoutMs) => send(message, ms),
      close: () => socket.end(),
    } as HelperClient;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}
