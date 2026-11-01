import { setDefaultTimeout, afterEach, describe, expect, test } from "bun:test";
setDefaultTimeout(30_000);
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createBackupEngine, type BackupEngineOptions } from "../engine.ts";
import { gitText, isolatedGitEnv, permissiveGuards, sandbox, type Sandbox } from "../test-fixtures.ts";
import { connectHelper, HelperClientError } from "./client.ts";
import { parseHelperConfig, type HelperConfig } from "./config.ts";
import { MAX_LINE_BYTES, MAX_REPLY_BYTES, PROTOCOL_VERSION } from "./protocol.ts";
import { HelperStartError, startHelper, type HelperHandle } from "./server.ts";
import type { BackupStatus, CaptureResult } from "../engine.ts";
import type { CycleReportView, VaultStatusView } from "./status-view.ts";

// Guards that are not under test here; visibility is left to the helper's own local-remote rule.
const { remoteVisibility: _unused, ...guards } = permissiveGuards;
const engineOptions: Partial<BackupEngineOptions> = { ...guards, settleMs: 5, gitEnv: isolatedGitEnv };

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function fixture(): Sandbox {
  const sb = sandbox();
  cleanups.push(() => sb.cleanup());
  return sb;
}

function runtimeRoot(): string {
  // Short base: socket paths are limited to 103 bytes.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "vsh-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function put(root: string, path: string, content: string): void {
  const abs = join(root, ...path.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

async function enable(repo: string): Promise<void> {
  await createBackupEngine({ machineId: "helper-test", ...engineOptions, remoteVisibility: async () => "private" }).enable(repo);
}

async function config(vaults: Array<{ id: string; path: string }>): Promise<HelperConfig> {
  return parseHelperConfig({ configVersion: 1, machineId: "helper-test", captureIntervalMs: 3_600_000, vaults: vaults.map((v) => ({ ...v, include: ["notes"] })) });
}

async function start(cfg: HelperConfig, runtimeDir: string, extra: Partial<Parameters<typeof startHelper>[0]> = {}): Promise<HelperHandle> {
  const handle = await startHelper({ config: cfg, runtimeDir, maxRuntimeMs: 120_000, engineOptions, shutdownGraceMs: 5_000, ...extra });
  cleanups.push(async () => void (await handle.stop("test-cleanup")));
  return handle;
}

describe("helper over its socket", () => {
  test("syncNow runs a real cycle verified on the remote; status reports the engine's answer; nothing is enrolled implicitly", async () => {
    const enabled = fixture();
    const unenabled = fixture();
    put(enabled.repo, "notes/a.md", "first draft\n");
    put(unenabled.repo, "notes/b.md", "other draft\n");
    await enable(enabled.repo);
    const rt = join(runtimeRoot(), "rt");
    const handle = await start(await config([{ id: "on", path: enabled.repo }, { id: "off", path: unenabled.repo }]), rt);
    expect(statSync(rt).mode & 0o777).toBe(0o700);
    expect(statSync(handle.socketPath).mode & 0o777).toBe(0o600);

    const client = await connectHelper(handle.socketPath, { client: "test" });
    cleanups.push(() => client.close());
    const sync = await client.request("syncNow", { vault: "on" }, 25_000);
    expect(sync.ok).toBe(true);
    const report = (sync as { result: CycleReportView }).result;
    expect(report.outcome).toBe("verified");
    const remoteTip = gitText(enabled.remote, ["for-each-ref", "--format=%(objectname)", "refs/heads/backup/"]);
    expect(remoteTip).toBe(report.capture!.snapshot!);

    const off = (await client.request("syncNow", { vault: "off" })) as { ok: true; result: CycleReportView };
    expect(off.result.outcome).toBe("blocked");
    expect(off.result.block?.reason).toBe("not-enabled");
    expect(gitText(unenabled.remote, ["for-each-ref", "refs/heads/"])).toBe("");

    const status = (await client.request("status")) as { ok: true; result: { helper: { protocol: number }; vaults: VaultStatusView[] } };
    expect(status.result.helper.protocol).toBe(PROTOCOL_VERSION);
    const [on, offStatus] = status.result.vaults;
    expect(on!.fresh).toBe(true);
    expect(on!.summary).toBe("no-known-unprotected-edits");
    expect(on!.engine!.lastVerifiedSnapshot).toBe(report.capture!.snapshot);
    expect(offStatus!.summary).toBe("not-enabled");
    // Status and cycles never enable a vault.
    expect(existsSync(join(unenabled.repo, ".git", "vault-sync", "enablement.json"))).toBe(false);
  });

  test("protocol: version handshake, reserved receipt methods, unknown vaults, unexpected fields and long lines", async () => {
    const sb = fixture();
    const handle = await start(await config([{ id: "v", path: sb.repo }]), join(runtimeRoot(), "rt"));
    await expect(connectHelper(handle.socketPath, { client: "old-app", protocol: 2 })).rejects.toMatchObject({ code: "protocol-mismatch" });

    const client = await connectHelper(handle.socketPath, { client: "test" });
    cleanups.push(() => client.close());
    for (const method of ["noteEdit", "noteWriteStart", "noteFlush"]) {
      expect(await client.raw({ id: 7, method, vault: "v" })).toMatchObject({ id: 7, ok: false, error: { code: "not-available" } });
    }
    expect(await client.raw({ id: 8, method: "run", vault: "v" })).toMatchObject({ ok: false, error: { code: "unknown-method" } });
    expect(await client.request("syncNow", { vault: "nope" })).toMatchObject({ ok: false, error: { code: "unknown-vault" } });
    expect(await client.raw({ id: 9, method: "status", vault: "v", path: "/" })).toMatchObject({ ok: false, error: { code: "bad-request" } });
    expect(await client.raw({ id: 10, method: "syncNow", vault: "../v" })).toMatchObject({ ok: false, error: { code: "bad-request" } });

    // A request before hello is refused; an endless line closes the connection.
    const answers = await rawExchange(handle.socketPath, `${JSON.stringify({ id: 1, method: "status" })}\n`);
    expect(answers[0]).toMatchObject({ ok: false, error: { code: "hello-required" } });
    const long = await rawExchange(handle.socketPath, `${JSON.stringify({ type: "hello", protocol: 1, client: "x" })}\n${"x".repeat(MAX_LINE_BYTES + 10)}`);
    expect(long.at(-1)).toMatchObject({ ok: false, error: { code: "bad-request" } });
  });

  test("one owner per runtime folder: a second helper is refused and the first keeps serving", async () => {
    const sb = fixture();
    const rt = join(runtimeRoot(), "rt");
    const cfg = await config([{ id: "v", path: sb.repo }]);
    const first = await start(cfg, rt);
    await expect(startHelper({ config: cfg, runtimeDir: rt, maxRuntimeMs: 10_000, engineOptions })).rejects.toThrow("another helper already owns this runtime folder");
    const client = await connectHelper(first.socketPath, { client: "test" });
    cleanups.push(() => client.close());
    expect((await client.request("status")).ok).toBe(true);
  });

  test("one owner per vault: a helper with another runtime folder cannot claim a vault already claimed", async () => {
    const shared = fixture();
    const other = fixture();
    const first = await start(await config([{ id: "shared", path: shared.repo }]), join(runtimeRoot(), "rt"));
    const second = { config: await config([{ id: "other", path: other.repo }, { id: "shared2", path: shared.repo }]), runtimeDir: join(runtimeRoot(), "rt"), maxRuntimeMs: 10_000, engineOptions };
    await expect(startHelper(second)).rejects.toThrow("another helper already backs up vault shared2");
    // The refused helper released the claims it took and left no socket.
    expect(existsSync(join(second.runtimeDir, "helper.sock"))).toBe(false);
    await first.stop();
    const later = await start(second.config, second.runtimeDir);
    const client = await connectHelper(later.socketPath, { client: "test" });
    cleanups.push(() => client.close());
    expect((await client.request("status")).ok).toBe(true);
  });

  test("a dead owner's socket is replaced; a non-socket file is left alone and refused", async () => {
    const sb = fixture();
    const cfg = await config([{ id: "v", path: sb.repo }]);
    const rt = join(runtimeRoot(), "rt");
    mkdirSync(rt, { mode: 0o700 });
    const socket = join(rt, "helper.sock");
    const made = spawnSync("python3", ["-I", "-c", "import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])", socket]);
    expect(made.status).toBe(0);
    expect(statSync(socket).isSocket()).toBe(true);
    const handle = await start(cfg, rt);
    const client = await connectHelper(handle.socketPath, { client: "test" });
    expect((await client.request("status")).ok).toBe(true);
    client.close();
    await handle.stop();

    const rt2 = join(runtimeRoot(), "rt");
    mkdirSync(rt2, { mode: 0o700 });
    writeFileSync(join(rt2, "helper.sock"), "not a socket");
    await expect(startHelper({ config: cfg, runtimeDir: rt2, maxRuntimeMs: 10_000, engineOptions })).rejects.toThrow("non-socket");
    expect(existsSync(join(rt2, "helper.sock"))).toBe(true);
  });

  test("refuses a runtime folder other users can reach or a link in its place", async () => {
    const sb = fixture();
    const cfg = await config([{ id: "v", path: sb.repo }]);
    const root = runtimeRoot();
    const open = join(root, "open");
    mkdirSync(open);
    chmodSync(open, 0o755);
    await expect(startHelper({ config: cfg, runtimeDir: open, maxRuntimeMs: 10_000, engineOptions })).rejects.toThrow("mode 0700");
    const real = join(root, "real");
    mkdirSync(real, { mode: 0o700 });
    spawnSync("ln", ["-s", real, join(root, "link")]);
    await expect(startHelper({ config: cfg, runtimeDir: join(root, "link"), maxRuntimeMs: 10_000, engineOptions })).rejects.toThrow("not a link");
    await expect(startHelper({ config: cfg, runtimeDir: "relative/rt", maxRuntimeMs: 10_000, engineOptions })).rejects.toThrow("absolute");
    await expect(startHelper({ config: cfg, runtimeDir: join(root, "x".repeat(120)), maxRuntimeMs: 10_000, engineOptions })).rejects.toThrow("103 bytes");
    await expect(startHelper({ config: cfg, runtimeDir: join(root, "r2"), maxRuntimeMs: 7 * 60 * 60_000, engineOptions })).rejects.toThrow("maxRuntimeMs");
  });

  test("the runtime bound stops the helper and shutdown removes the socket and the owner ticket", async () => {
    const sb = fixture();
    const rt = join(runtimeRoot(), "rt");
    const events: string[] = [];
    const handle = await startHelper({ config: await config([{ id: "v", path: sb.repo }]), runtimeDir: rt, maxRuntimeMs: 300, engineOptions, onEvent: (e) => events.push(e.type === "stopping" ? `stopping:${e.reason}` : e.type) });
    await handle.done;
    expect(events).toEqual(["started", "stopping:max-runtime", "stopped"]);
    expect(existsSync(handle.socketPath)).toBe(false);
    expect(readdirSync(join(rt, "owner.lock"))).toEqual([]);
    await expect(connectHelper(handle.socketPath, { client: "test" })).rejects.toThrow();
  });

  test("vaults are isolated: one vault's failing engine does not affect another's cycle or status", async () => {
    const good = fixture();
    const bad = fixture();
    put(good.repo, "notes/a.md", "text\n");
    await enable(good.repo);
    const handle = await start(await config([{ id: "good", path: good.repo }, { id: "bad", path: bad.repo }]), join(runtimeRoot(), "rt"), {
      createEngine: (vault, options) => {
        const real = createBackupEngine(options);
        if (vault.id !== "bad") return real;
        return { ...real, capture: async () => { throw new Error("injected failure"); }, status: async () => { throw new Error("injected status failure"); } };
      },
    });
    const client = await connectHelper(handle.socketPath, { client: "test" });
    cleanups.push(() => client.close());
    const [badSync, goodSync] = await Promise.all([client.request("syncNow", { vault: "bad" }), connectHelper(handle.socketPath, { client: "test2" }).then(async (c) => { cleanups.push(() => c.close()); return c.request("syncNow", { vault: "good" }, 25_000); })]);
    expect((badSync as { result: CycleReportView }).result).toMatchObject({ outcome: "capture-failed", error: "injected failure" });
    expect((goodSync as { result: CycleReportView }).result.outcome).toBe("verified");
    const status = (await client.request("status")) as { result: { vaults: VaultStatusView[] } };
    const byId = Object.fromEntries(status.result.vaults.map((v) => [v.vault, v]));
    expect(byId.bad).toMatchObject({ summary: "unknown", fresh: false, statusError: "injected status failure" });
    expect(byId.good!.summary).toBe("no-known-unprotected-edits");
  });

  test("a non-local remote is held back as visibility unknown, never pushed", async () => {
    const sb = fixture();
    put(sb.repo, "notes/a.md", "text\n");
    gitText(sb.repo, ["remote", "set-url", "origin", "https://example.invalid/owner/repo.git"]);
    await createBackupEngine({ machineId: "helper-test", ...engineOptions, remoteVisibility: async () => "private" }).enable(sb.repo);
    const handle = await start(await config([{ id: "v", path: sb.repo }]), join(runtimeRoot(), "rt"));
    const client = await connectHelper(handle.socketPath, { client: "test" });
    cleanups.push(() => client.close());
    const sync = (await client.request("syncNow", { vault: "v" }, 25_000)) as { result: CycleReportView };
    expect(sync.result.outcome).toBe("blocked");
    expect(sync.result.block?.reason).toBe("visibility-unknown");
    const status = (await client.request("status", { vault: "v" })) as { result: { vaults: VaultStatusView[] } };
    expect(status.result.vaults[0]!.summary).toBe("blocked");
    expect(status.result.vaults[0]!.engine!.lastVerifiedSnapshot).toBeNull();
  });
});

describe("client", () => {
  test("refuses a socket in a folder other users can reach", async () => {
    const root = runtimeRoot();
    const open = join(root, "open");
    mkdirSync(open);
    chmodSync(open, 0o755);
    await expect(connectHelper(join(open, "helper.sock"), { client: "test" })).rejects.toThrow("mode 0700");
  });
});

/** Sends raw bytes and collects every JSON line until the helper closes the connection. */
function rawExchange(socketPath: string, payload: string): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let data = "";
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (c) => { data += c.toString(); });
    socket.on("error", reject);
    socket.on("close", () => resolve(data.split("\n").filter(Boolean).map((l) => JSON.parse(l))));
    setTimeout(() => socket.destroy(), 5_000);
  });
}

void HelperClientError;

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
}
const noSnapshot = (): CaptureResult => ({ committed: false, snapshot: null, ref: null, startedAt: 0, added: [], modified: [], removed: [], pending: [], skipped: [] });
function engineStatus(overrides: Partial<BackupStatus> = {}): BackupStatus {
  return {
    machineId: "m", checkoutId: "c", protectionAgeSeconds: 0, oldestUnprotectedEdit: null, lastVerifiedSnapshot: null, lastVerifiedAt: null, protectedThrough: null,
    latestSnapshot: null, latestRef: null, lastPushed: null, pending: [], unlistedFolders: [], unflushedEditSince: null, writing: [], lastError: null,
    recoveredFromDamagedRecord: false, repositoryHooksNotRun: [], enabled: true, remote: "origin", block: null, ...overrides,
  };
}
/** Engine double: capture and status are the test's; push and verify are never reached without a snapshot. */
function double(parts: { capture?: (repo: string, scope: unknown, opts?: { signal?: AbortSignal }) => Promise<CaptureResult>; status?: () => Promise<BackupStatus> } = {}) {
  return {
    capture: parts.capture ?? (async () => noSnapshot()),
    pushBackup: async () => { throw new Error("not reached"); },
    verify: async () => { throw new Error("not reached"); },
    status: parts.status ?? (async () => engineStatus()),
  } as never;
}
const tickets = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith("ticket-")) : []);

describe("shutdown is bounded and keeps ownership until work ends (review finding 3)", () => {
  test("stop answers 'overdue' within grace + hard stop when a cycle ignores cancellation; claims stay held until it ends", async () => {
    const sb = fixture();
    const base = runtimeRoot();
    const rt = join(base, "rt");
    const cfg = await config([{ id: "v", path: sb.repo }]);
    const hold = gate();
    let signal: AbortSignal | undefined;
    const events: string[] = [];
    const handle = await startHelper({
      config: cfg, runtimeDir: rt, maxRuntimeMs: 60_000, engineOptions, shutdownGraceMs: 20, hardStopMs: 100, onEvent: (e) => events.push(e.type),
      createEngine: () => double({ capture: async (_r, _s, o) => { signal = o?.signal; await hold.promise; return noSnapshot(); } }),
    });
    cleanups.push(async () => { hold.open(); await handle.done; });
    const client = await connectHelper(handle.socketPath, { client: "test" });
    const sync = client.request("syncNow", { vault: "v" }, 10_000).catch((e: unknown) => e);
    for (let i = 0; i < 100 && !signal; i++) await pause(5);
    const t0 = Date.now();
    const result = await handle.stop("test");
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(result).toEqual({ state: "overdue", unsettled: [{ vault: "v", work: ["cycle"] }], processGroups: [] });
    expect(signal!.aborted).toBe(true);
    expect(await sync).toBeInstanceOf(HelperClientError);
    expect(events).toEqual(["started", "stopping", "overdue"]);
    // Every claim is still held: the runtime folder and the vault, by name and from another runtime folder.
    expect(tickets(join(rt, "owner.lock")).length).toBe(1);
    expect(tickets(join(sb.repo, ".git", "vault-sync", "helper-owner")).length).toBe(1);
    await expect(startHelper({ config: cfg, runtimeDir: rt, maxRuntimeMs: 10_000, engineOptions })).rejects.toThrow("already owns this runtime folder");
    await expect(startHelper({ config: cfg, runtimeDir: join(base, "other"), maxRuntimeMs: 10_000, engineOptions })).rejects.toThrow("already backs up vault v");
    await expect(connectHelper(handle.socketPath, { client: "test" })).rejects.toThrow();
    let released = false;
    void handle.done.then(() => { released = true; });
    await pause(50);
    expect(released).toBe(false);
    hold.open();
    await handle.done;
    expect(events).toEqual(["started", "stopping", "overdue", "cycle", "stopped"]);
    expect(tickets(join(rt, "owner.lock"))).toEqual([]);
    expect(tickets(join(sb.repo, ".git", "vault-sync", "helper-owner"))).toEqual([]);
    expect(await handle.outcome).toEqual(result);
    const successor = await start(cfg, join(base, "next"));
    await successor.stop();
  });

  test("a cycle that ends after cancellation within the bound gives 'stopped' with the claims released", async () => {
    const sb = fixture();
    const rt = join(runtimeRoot(), "rt");
    let started = false;
    const handle = await startHelper({
      config: await config([{ id: "v", path: sb.repo }]), runtimeDir: rt, maxRuntimeMs: 60_000, engineOptions, shutdownGraceMs: 20, hardStopMs: 2_000,
      createEngine: () => double({ capture: (_r, _s, o) => { started = true; return new Promise((res) => o?.signal?.addEventListener("abort", () => setTimeout(() => res(noSnapshot()), 30))); } }),
    });
    const client = await connectHelper(handle.socketPath, { client: "test" });
    const sync = client.request("syncNow", { vault: "v" }, 10_000).catch((e: unknown) => e);
    for (let i = 0; i < 100 && !started; i++) await pause(5);
    expect(await handle.stop()).toEqual({ state: "stopped" });
    expect(tickets(join(rt, "owner.lock"))).toEqual([]);
    expect(existsSync(handle.socketPath)).toBe(false);
    await sync;
  });
});

describe("a failed start unwinds what it acquired before releasing ownership (review finding 4)", () => {
  test("a real chmod failure after listen closes the server and releases the claims only after", async () => {
    const sb = fixture();
    const rt = join(runtimeRoot(), "rt");
    const originalListen = Server.prototype.listen;
    let captured: Server | undefined;
    Server.prototype.listen = function (this: Server, ...args: unknown[]) {
      captured = this;
      const done = args[args.length - 1] as () => void;
      const path = args[0] as string;
      args[args.length - 1] = () => { rmSync(path, { force: true }); done(); };
      return (originalListen as (...a: unknown[]) => Server).apply(this, args);
    } as typeof Server.prototype.listen;
    try {
      const failure = await startHelper({ config: await config([{ id: "v", path: sb.repo }]), runtimeDir: rt, maxRuntimeMs: 10_000, engineOptions, createEngine: () => double() }).then(() => null, (e: unknown) => e);
      expect(failure).toBeInstanceOf(HelperStartError);
      expect(failure).toMatchObject({ code: "ENOENT", shutdown: { state: "stopped" } });
      expect(captured?.listening).toBe(false);
      expect(tickets(join(rt, "owner.lock"))).toEqual([]);
      expect(tickets(join(sb.repo, ".git", "vault-sync", "helper-owner"))).toEqual([]);
    } finally {
      Server.prototype.listen = originalListen;
      if (captured?.listening) await new Promise<void>((r) => captured!.close(() => r()));
    }
  });

  test("a timer failure after the workers start stops them before the claims are released; a successor never overlaps", async () => {
    const sb = fixture();
    const base = runtimeRoot();
    const cfg = parseHelperConfig({ configVersion: 1, machineId: "helper-test", captureIntervalMs: 1_000, vaults: [{ id: "v", path: sb.repo, include: ["notes"] }] });
    let active = 0;
    let maxActive = 0;
    let captures = 0;
    const counting = () => double({ capture: async () => { captures++; active++; maxActive = Math.max(maxActive, active); await pause(20); active--; return noSnapshot(); } });
    let count = 0;
    const timers = { set(fn: () => void, ms: number) { if (++count === 2) throw new Error("injected timer failure"); return setTimeout(fn, ms); }, clear(h: unknown) { clearTimeout(h as ReturnType<typeof setTimeout>); } };
    const failure = await startHelper({ config: await cfg, runtimeDir: join(base, "rt"), maxRuntimeMs: 10_000, engineOptions, timers, pollMs: 5, createEngine: counting }).then(() => null, (e: unknown) => e);
    expect(failure).toMatchObject({ message: "injected timer failure", shutdown: { state: "stopped" } });
    expect(tickets(join(base, "rt", "owner.lock"))).toEqual([]);
    expect(existsSync(join(base, "rt", "helper.sock"))).toBe(false);
    await pause(1_200);
    expect(captures).toBe(0);
    const successor = await start(await cfg, join(base, "next"), { createEngine: counting, pollMs: 5 });
    await pause(1_200);
    await successor.stop();
    expect(captures).toBeGreaterThan(0);
    expect(maxActive).toBe(1);
  });
});

describe("status replies stay inside the reply limit without hiding anything (review finding 6)", () => {
  test("5 000 pending paths arrive as an exact count with a sample, and the vault stays unprotected", async () => {
    const sb = fixture();
    const pending = Array.from({ length: 5_000 }, (_, i) => `notes/pending-${i}.md`);
    const handle = await start(await config([{ id: "v", path: sb.repo }]), join(runtimeRoot(), "rt"), { createEngine: () => double({ status: async () => engineStatus({ pending }) }) });
    const client = await connectHelper(handle.socketPath, { client: "test" });
    cleanups.push(() => client.close());
    const response = (await client.request("status")) as { ok: true; result: { vaults: VaultStatusView[] } };
    const v = response.result.vaults[0]!;
    expect(v.engine!.pending).toMatchObject({ count: 5_000, omitted: 4_900 });
    expect(v.engine!.pending.items).toEqual(pending.slice(0, 100));
    expect(v.summary).toBe("unprotected");
    expect(v.uncertainty).toContain("pending-files");
  });

  test("when even the sample is too large it shrinks, down to counts only, and the reply still fits", async () => {
    const sb = fixture();
    const long = Array.from({ length: 200 }, (_, i) => `notes/${String(i).padStart(4, "0")}-${"x".repeat(20_000)}.md`);
    const handle = await start(await config([{ id: "v", path: sb.repo }]), join(runtimeRoot(), "rt"), { createEngine: () => double({ status: async () => engineStatus({ pending: long, unlistedFolders: long, writing: long }) }) });
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect(handle.socketPath);
      let data = "";
      socket.on("data", (c) => {
        data += c.toString();
        const lines = data.split("\n");
        if (lines.length >= 3) { socket.destroy(); resolve(lines[1]!); }
      });
      socket.on("error", reject);
      socket.write(`${JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, client: "raw" })}\n${JSON.stringify({ id: 1, method: "status" })}\n`);
    });
    expect(Buffer.byteLength(raw) + 1).toBeLessThanOrEqual(MAX_REPLY_BYTES);
    const v = (JSON.parse(raw) as { result: { vaults: VaultStatusView[] } }).result.vaults[0]!;
    expect(v.engine!.pending.count).toBe(200);
    expect(v.engine!.pending.items.length).toBe(10);
    expect(v.engine!.writing.omitted).toBe(190);
    expect(v.summary).toBe("unprotected");
  });
});

describe("one runtime folder however it is named (review finding 1)", () => {
  test("a helper started through a linked parent uses the real folder; the same folder by its real name is already owned", async () => {
    const sb = fixture();
    const base = runtimeRoot();
    spawnSync("ln", ["-s", base, join(base, "alias")]);
    const cfg = await config([{ id: "v", path: sb.repo }]);
    const handle = await start(cfg, join(base, "alias", "rt"));
    expect(handle.socketPath).toBe(join(base, "rt", "helper.sock"));
    expect(tickets(join(base, "rt", "owner.lock")).length).toBe(1);
    await expect(startHelper({ config: cfg, runtimeDir: join(base, "rt"), maxRuntimeMs: 10_000, engineOptions })).rejects.toThrow("already owns this runtime folder");
    await expect(startHelper({ config: cfg, runtimeDir: `${base}/alias/../rt`, maxRuntimeMs: 10_000, engineOptions })).rejects.toThrow("'..' segments");
    const client = await connectHelper(join(base, "alias", "rt", "helper.sock"), { client: "test" });
    expect((await client.request("status")).ok).toBe(true);
    client.close();
    expect(await handle.stop()).toEqual({ state: "stopped" });
    expect(existsSync(join(base, "rt", "helper.sock"))).toBe(false);
  });
});
