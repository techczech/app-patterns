import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectHelper } from "./client.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A disposable peer on a private socket: `answer` gets each received message and its index. */
async function peer(answer: (socket: Socket, index: number, message: Record<string, unknown>) => void) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "vsh-peer-")));
  const rt = join(dir, "rt");
  mkdirSync(rt, { mode: 0o700 });
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let data = "";
    let index = 0;
    socket.on("data", (chunk) => {
      data += chunk.toString();
      for (let end = data.indexOf("\n"); end >= 0; end = data.indexOf("\n")) {
        const line = data.slice(0, end);
        data = data.slice(end + 1);
        answer(socket, index++, JSON.parse(line));
      }
    });
  });
  const path = join(rt, "helper.sock");
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(path, res);
  });
  cleanups.push(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((res) => server.close(() => res()));
    rmSync(dir, { recursive: true, force: true });
  });
  return { path, dir, sockets };
}

const hello = (extra: Record<string, unknown> = {}) => `${JSON.stringify({ type: "hello", ok: true, protocol: 1, helperVersion: "fake", ...extra })}\n`;
const waitClosed = async (sockets: Set<Socket>) => {
  for (let i = 0; i < 50 && sockets.size > 0; i++) await pause(10);
  return sockets.size;
};

describe("client checks every reply (review finding 5)", () => {
  test("a hello for another protocol is refused and the connection closed", async () => {
    const p = await peer((s, i) => { if (i === 0) s.write(hello({ protocol: 999 })); });
    await expect(connectHelper(p.path, { client: "test", timeoutMs: 500 })).rejects.toMatchObject({ code: "bad-reply" });
    expect(await waitClosed(p.sockets)).toBe(0);
  });

  test("a reply carrying another request's id fails the request and closes the connection", async () => {
    const p = await peer((s, i, m) => s.write(i === 0 ? hello() : `${JSON.stringify({ id: (m.id as number) + 100, ok: true, result: { vault: "wrong-cycle" } })}\n`));
    const client = await connectHelper(p.path, { client: "test", timeoutMs: 500 });
    cleanups.push(() => client.close());
    await expect(client.request("syncNow", { vault: "v" })).rejects.toMatchObject({ code: "bad-reply" });
    expect(await waitClosed(p.sockets)).toBe(0);
    await expect(client.request("status")).rejects.toThrow();
  });

  test("malformed envelopes, unknown fields and unasked-for lines are refused", async () => {
    const cases = [
      `${JSON.stringify({ id: 1, ok: true })}\n`,
      `${JSON.stringify({ id: 1, ok: true, result: {}, extra: 1 })}\n`,
      `${JSON.stringify({ id: 1, ok: false, error: { code: "made-up", message: "x" } })}\n`,
      `${JSON.stringify({ id: 1, ok: "yes", result: {} })}\n`,
      `${JSON.stringify({ id: 1, ok: true, result: {} })}\n${JSON.stringify({ id: 2, ok: true, result: {} })}\n`,
    ];
    for (const reply of cases) {
      const p = await peer((s, i) => s.write(i === 0 ? hello() : reply));
      const client = await connectHelper(p.path, { client: "test", timeoutMs: 500 });
      cleanups.push(() => client.close());
      const first = client.request("status").then((r) => r, (e: unknown) => e);
      const result = await first;
      if (reply.includes('"id":2')) {
        // The first reply is valid; the unasked-for second one closes the connection.
        expect(result).toMatchObject({ id: 1, ok: true });
      } else {
        expect(result).toMatchObject({ code: "bad-reply" });
      }
      expect(await waitClosed(p.sockets)).toBe(0);
    }
  });

  test("an error the helper could not tie to a request is not returned as this request's answer", async () => {
    const p = await peer((s, i) => s.write(i === 0 ? hello() : `${JSON.stringify({ id: null, ok: false, error: { code: "bad-request", message: "too many queued requests on this connection" } })}\n`));
    const client = await connectHelper(p.path, { client: "test", timeoutMs: 500 });
    await expect(client.request("status")).rejects.toMatchObject({ code: "bad-request" });
    expect(await waitClosed(p.sockets)).toBe(0);
  });

  test("a socket path with '..' is refused and a linked parent is resolved to the real folder", async () => {
    const p = await peer((s, i, m) => s.write(i === 0 ? hello() : `${JSON.stringify({ id: m.id, ok: true, result: { fine: true } })}\n`));
    await expect(connectHelper(`${p.dir}/rt/../rt/helper.sock`, { client: "test" })).rejects.toThrow("'..' segments");
    symlinkSync(p.dir, join(p.dir, "alias"));
    const client = await connectHelper(join(p.dir, "alias", "rt", "helper.sock"), { client: "test", timeoutMs: 500 });
    expect(await client.request("status")).toEqual({ id: 1, ok: true, result: { fine: true } });
    client.close();
  });
});

describe("a failed connect closes its socket (review finding 7)", () => {
  test("malformed hello", async () => {
    const p = await peer((s, i) => { if (i === 0) s.write("not-json\n"); });
    await expect(connectHelper(p.path, { client: "test", timeoutMs: 500 })).rejects.toMatchObject({ code: "bad-reply" });
    expect(await waitClosed(p.sockets)).toBe(0);
  });

  test("refused hello and silent peer", async () => {
    const refused = await peer((s, i) => { if (i === 0) s.write(`${JSON.stringify({ type: "hello", ok: false, protocol: 1, error: { code: "protocol-mismatch", message: "no" } })}\n`); });
    await expect(connectHelper(refused.path, { client: "test", timeoutMs: 500 })).rejects.toMatchObject({ code: "protocol-mismatch" });
    expect(await waitClosed(refused.sockets)).toBe(0);
    const silent = await peer(() => undefined);
    await expect(connectHelper(silent.path, { client: "test", timeoutMs: 50 })).rejects.toMatchObject({ code: "timeout" });
    expect(await waitClosed(silent.sockets)).toBe(0);
  });
});
