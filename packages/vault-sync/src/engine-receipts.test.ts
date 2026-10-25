import { setDefaultTimeout, afterEach, describe, expect, test } from "bun:test";
setDefaultTimeout(30_000);
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { backupPrefix } from "./backup-ref.ts";
import { captureSnapshot, type CaptureDeps, type RepoContext } from "./capture.ts";
import { convertedRecord, parseRecordDetailed } from "./deadline.ts";
import { receiptTestHooks } from "./engine-receipts.ts";
import { checkoutId, engineFolder, ensureEngineFolder, loadRecord, saveRecord, storeTestHooks, withFolderLock } from "./engine-store.ts";
import { createGitRunner } from "./git-process.ts";
import { createBackupEngine, type BackupEngineOptions, type ReceiptError, type ReceiptResult, type ReceiptSession, type SeqRequest } from "./index.ts";
import { gitText, isolatedGitEnv, permissiveGuards, sandbox, type Sandbox } from "./test-fixtures.ts";

/** Editor receipts through the engine and its record file (plan-editor-receipts-protocol-v2 §7, §11, E1 T1-T4). */

const sandboxes: Sandbox[] = [];
afterEach(() => {
  while (sandboxes.length) sandboxes.pop()!.cleanup();
  for (const key of Object.keys(storeTestHooks)) delete (storeTestHooks as Record<string, unknown>)[key];
  for (const key of Object.keys(receiptTestHooks)) delete (receiptTestHooks as Record<string, unknown>)[key];
});

const HELPER = { host: "host-a", pid: 100, startedAt: 1000, helperVersion: "0.2.0" };
const C1 = "c".repeat(32);
const O1 = "1".repeat(32);
const I1 = "e".repeat(32);
const DOC = { owner: O1, ownerEpoch: 1, docEpoch: 1 };
const WRITER = { host: "host-a", pid: 201, startedAt: 5001, clientEpoch: 1 };

function setup(): Sandbox {
  const sb = sandbox();
  sandboxes.push(sb);
  put(sb.repo, "notes/a.md", "A\n");
  return sb;
}

function put(root: string, path: string, content: string): void {
  const abs = join(root, ...path.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

let clock = 1_800_000_000_000;
function engine(overrides: Partial<BackupEngineOptions> = {}) {
  return createBackupEngine({ machineId: "test-machine", settleMs: 0, gitEnv: isolatedGitEnv, ...permissiveGuards, now: () => clock, ...overrides });
}
type Engine = ReturnType<typeof engine>;

const recordFile = (repo: string) => join(repo, ".git", "vault-sync", "deadline.json");
const fileHash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const blobOf = (text: string) => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");

async function session(e: Engine, repo: string): Promise<ReceiptSession> {
  const s: ReceiptSession = { helper: HELPER, clientId: C1, clientEpoch: 1, writer: WRITER, recordId: null, streamId: null };
  const opened = await e.receipts.openStream(repo, s, { helper: HELPER, exclusive: true, prior: null }, { id: 0, method: "openStream", vault: "v", knownRecordId: null, knownStreamId: null, nextSeq: 1, ackedThrough: 0 });
  if ("error" in opened) throw new Error(opened.error);
  return { ...s, recordId: opened.recordId, streamId: opened.streamId };
}

const editReq = (seq: number, throughGen: number, ackedThrough = seq - 1, at = clock - 10): SeqRequest => ({ id: seq, vault: "v", seq, ackedThrough, method: "noteEdit", path: "notes/a.md", doc: DOC, throughGen, at });
const flushReq = (seq: number, gen: number, editRef: number, blobOid: string): SeqRequest => ({ id: seq, vault: "v", seq, ackedThrough: seq - 1, method: "noteFlush", path: "notes/a.md", doc: DOC, gen, intent: I1, editRef, writeRef: null, blobOid });
const errorOf = (r: ReceiptResult | ReceiptError | object) => ("error" in r ? (r as ReceiptError).error : null);
const ticketOf = (r: ReceiptResult | ReceiptError) => (r as Extract<ReceiptResult, { ok: "edit" }>).ticket;
const storedLedger = (repo: string) => JSON.parse(readFileSync(recordFile(repo), "utf8")).receipts;

describe("durability and crash windows (T1, I1)", () => {
  test("a failure in each window applies the receipt at most once, and the reply follows the folder sync", async () => {
    const { repo } = setup();
    const e = engine();
    const s = await session(e, repo);
    const file = recordFile(repo);
    const fail = (name: string) => (path: string) => { if (path === file) throw new Error(`injected ${name}`); };

    // (b) after the temporary file opened, before rename: maybe-applied class; the file is unchanged.
    const before = fileHash(file);
    storeTestHooks.afterTmpOpen = fail("after tmp open");
    expect(errorOf(await e.receipts.apply(repo, s, editReq(1, 1)))).toBe("outcome-unknown");
    delete storeTestHooks.afterTmpOpen;
    expect(fileHash(file)).toBe(before);
    expect(readdirSync(dirname(file)).filter((n) => n.includes(".tmp-"))).toEqual([]);
    const applied = await e.receipts.apply(repo, s, editReq(1, 1));
    expect(ticketOf(applied)).toBe(1);

    // (c) after rename, before the folder sync: applied; the identical resend gets the cached reply.
    storeTestHooks.afterRename = fail("after rename");
    expect(errorOf(await e.receipts.apply(repo, s, editReq(2, 2)))).toBe("outcome-unknown");
    delete storeTestHooks.afterRename;
    const second = await e.receipts.apply(repo, s, editReq(2, 2));
    expect(ticketOf(second)).toBe(2);
    expect(storedLedger(repo).clients[C1].appliedThrough).toBe(2);

    // (d) durable, then the reply is lost: cached identical reply, no second effect.
    receiptTestHooks.beforeReply = () => { throw new Error("injected lost reply"); };
    expect(errorOf(await e.receipts.apply(repo, s, editReq(3, 3)))).toBe("outcome-unknown");
    delete receiptTestHooks.beforeReply;
    const third = await e.receipts.apply(repo, s, editReq(3, 3, 2));
    expect(ticketOf(third)).toBe(3);
    expect(await e.receipts.apply(repo, s, editReq(3, 3, 2))).toEqual(third);
    expect(JSON.parse(readFileSync(file, "utf8")).generation).toBe(3);

    // A cached reply runs the barrier too; a failed barrier is maybe-applied, never a silent success.
    storeTestHooks.beforeBarrier = fail("barrier");
    expect(errorOf(await e.receipts.apply(repo, s, editReq(3, 3, 2)))).toBe("outcome-unknown");
    delete storeTestHooks.beforeBarrier;

    // Order of the durable steps before a reply.
    const order: string[] = [];
    storeTestHooks.afterTmpOpen = (p) => { if (p === file) order.push("tmp"); };
    storeTestHooks.afterRename = (p) => { if (p === file) order.push("rename"); };
    storeTestHooks.afterDirSync = (p) => { if (p === file) order.push("dir-sync"); };
    receiptTestHooks.beforeReply = () => { order.push("reply"); };
    await e.receipts.apply(repo, s, editReq(4, 4));
    expect(order).toEqual(["tmp", "rename", "dir-sync", "reply"]);
    order.length = 0;
    storeTestHooks.beforeBarrier = (p) => { if (p === file) order.push("barrier"); };
    await e.receipts.apply(repo, s, editReq(4, 4, 3));
    expect(order).toEqual(["barrier", "reply"]);
  });

  test("a held record lock answers busy within the receipt budget and changes nothing; the operation lock does not delay receipts (T4, I15)", async () => {
    const { repo } = setup();
    const e = engine({ lockWaitMs: 120_000 });
    const s = await session(e, repo);
    const folder = engineFolder(join(repo, ".git"));
    const before = fileHash(recordFile(repo));
    let busy: ReceiptResult | ReceiptError | null = null;
    let waited = 0;
    await withFolderLock(folder.recordLockDir, { waitMs: 1000 }, async () => {
      const t0 = performance.now();
      busy = await e.receipts.apply(repo, s, editReq(1, 1));
      waited = performance.now() - t0;
    });
    expect(errorOf(busy!)).toBe("busy");
    expect(waited).toBeGreaterThanOrEqual(1900);
    expect(waited).toBeLessThan(10_000);
    expect(fileHash(recordFile(repo))).toBe(before);
    // The same seq is free for the retry. With the operation lock held (a capture), receipts still apply.
    await withFolderLock(folder.lockDir, { waitMs: 1000 }, async () => {
      const t0 = performance.now();
      expect(ticketOf(await e.receipts.apply(repo, s, editReq(1, 1)))).toBe(1);
      expect(performance.now() - t0).toBeLessThan(1500);
      const status = await e.receipts.status(repo, s, [{ path: "notes/a.md", doc: DOC }]);
      expect("error" in status).toBe(false);
    });
  });

  test("errors that consume no seq leave the record file byte-identical (T2)", async () => {
    const { repo } = setup();
    const e = engine();
    const s = await session(e, repo);
    await e.receipts.apply(repo, s, editReq(1, 1));
    await e.receipts.apply(repo, s, editReq(2, 2));
    const before = fileHash(recordFile(repo));
    const cases: [SeqRequest | Record<string, unknown>, ReceiptSession, ReceiptError["error"]][] = [
      [editReq(4, 3, 2), s, "out-of-order"],
      [editReq(2, 9, 1), s, "conflict"],
      [editReq(1, 1, 1), s, "retired"],
      [editReq(3, 3, 5), s, "ack-ahead"],
      [editReq(3, 3, 2, clock + 3 * 86_400_000), s, "clock-ahead"],
      [{ ...editReq(3, 3), token: 4 }, s, "bad-request"],
      [{ ...editReq(3, 3), path: "../x.md" }, s, "bad-request"],
      [editReq(3, 3), { ...s, streamId: "9".repeat(32) }, "stream-required"],
      [editReq(3, 3), { ...s, helper: { ...HELPER, pid: 999 } }, "activation-refused"],
    ];
    for (const [req, who, expected] of cases) {
      expect(errorOf(await e.receipts.apply(repo, who, req as SeqRequest))).toBe(expected);
      expect(fileHash(recordFile(repo))).toBe(before);
    }
    expect(ticketOf(await e.receipts.apply(repo, s, editReq(3, 3)))).toBe(3);
  });
});

describe("record damage under the new engine (R1, §11)", () => {
  async function enabledWithSnapshot() {
    const sb = setup();
    const e = engine();
    await e.enable(sb.repo);
    const first = await e.capture(sb.repo, { include: ["notes"] });
    expect(first.committed).toBe(true);
    expect((await e.pushBackup(sb.repo)).state).toBe("pushed");
    return { ...sb, e, first };
  }

  async function captureWithResetBetweenReads(repo: string, reset: () => Promise<void>) {
    const folder = engineFolder(join(repo, ".git"));
    await ensureEngineFolder(folder);
    const id = await checkoutId(folder);
    const git = createGitRunner({ hooksDir: folder.hooksDir, env: isolatedGitEnv });
    const ctx: RepoContext = { root: repo, commonDir: join(repo, ".git"), folder, checkoutId: id, prefix: backupPrefix("test-machine", id), objectFormat: "sha1", zeroOid: "0".repeat(40), git, cache: new Map() };
    let reads = 0;
    const deps: CaptureDeps = {
      machineId: "test-machine", now: () => clock, settleMs: 0, retries: 0, maxFileBytes: 1024, author: { name: "Automatic backup", email: "backup@vault-sync.invalid" },
      run: (_c, signal, env) => ({ cwd: repo, timeoutMs: 10_000, maxOutputBytes: 1024 * 1024, signal, env }),
      readRecord: async () => {
        reads += 1;
        if (reads === 2) await reset();
        return withFolderLock(folder.recordLockDir, { waitMs: 5000 }, () => loadRecord(folder));
      },
      persist: (_c, change) => withFolderLock(folder.recordLockDir, { waitMs: 5000 }, async () => {
        const next = change(await loadRecord(folder));
        await saveRecord(folder, next);
        return next;
      }),
    };
    return withFolderLock(folder.lockDir, { waitMs: 5000 }, () => captureSnapshot(ctx, { include: ["notes"] }, deps));
  }

  test("a record that becomes unreadable during a capture discards it and quarantines capture and publication (CX-S2c, R1)", async () => {
    const { repo, remote, e, first } = await enabledWithSnapshot();
    clock += 1000;
    put(repo, "notes/a.md", "partial bytes of a paused writer\n");
    await expect(captureWithResetBetweenReads(repo, async () => writeFileSync(recordFile(repo), "{ torn"))).rejects.toThrow(/write guards/);
    const prefix = backupPrefix("test-machine", await checkoutId(engineFolder(join(repo, ".git"))));
    const tip = () => gitText(repo, ["for-each-ref", "--format=%(objectname)", prefix]);
    expect(tip()).toBe(first.snapshot!);
    // Quarantine persists across engines: capture refuses, publication refuses before sending.
    const again = engine();
    await expect(again.capture(repo, { include: ["notes"] })).rejects.toThrow(/write guards/);
    const pushed = await again.pushBackup(repo);
    expect(pushed.state).toBe("failed");
    expect((pushed as { message: string }).message).toMatch(/write guards/);
    const status = await again.status(repo);
    expect(status.oldestUnprotectedEdit).not.toBeNull();
    expect(readdirSync(dirname(recordFile(repo))).some((n) => n.startsWith("deadline.json.damaged-"))).toBe(true);
    expect(gitText(remote, ["for-each-ref", "--format=%(objectname)"])).toBe(first.snapshot!);
  });

  test("a ledger reset during a capture discards the attempt; the next capture runs (R1)", async () => {
    const { repo, e } = await enabledWithSnapshot();
    const s = await session(e, repo);
    await e.receipts.apply(repo, s, editReq(1, 1));
    clock += 1000;
    put(repo, "notes/a.md", "B\n");
    await expect(captureWithResetBetweenReads(repo, async () => {
      const raw = JSON.parse(readFileSync(recordFile(repo), "utf8"));
      raw.receipts.clients[C1].appliedThrough = 50;
      writeFileSync(recordFile(repo), JSON.stringify(raw));
    })).rejects.toThrow(/replaced while the capture was reading/);
    expect(readdirSync(dirname(recordFile(repo))).some((n) => n.startsWith("deadline.json.receipts-damaged-"))).toBe(true);
    expect((await e.capture(repo, { include: ["notes"] })).committed).toBe(true);
    // The repaired ledger needs re-activation; the old session's receipts are refused.
    expect(errorOf(await e.receipts.apply(repo, s, editReq(2, 2)))).toBe("activation-refused");
    expect(storedLedger(repo).resetFloor.reason).toBe("damaged-ledger");
  });

  test("a failed replacement of an unreadable record leaves it in place and refuses again (never an empty record)", async () => {
    const { repo } = setup();
    const e = engine();
    await e.receipts.status(repo, { helper: HELPER, clientId: C1, clientEpoch: 1, writer: null, recordId: null, streamId: null }, []);
    mkdirSync(dirname(recordFile(repo)), { recursive: true });
    writeFileSync(recordFile(repo), "{ not json");
    storeTestHooks.afterTmpOpen = (p) => { if (p === recordFile(repo)) throw new Error("injected"); };
    await expect(e.status(repo)).rejects.toThrow(/injected/);
    expect(readFileSync(recordFile(repo), "utf8")).toBe("{ not json");
    delete storeTestHooks.afterTmpOpen;
    const status = await e.status(repo);
    expect(status.recoveredFromDamagedRecord).toBe(true);
    const asides = readdirSync(dirname(recordFile(repo))).filter((n) => n.startsWith("deadline.json.damaged-"));
    expect(asides.length).toBeGreaterThanOrEqual(1);
    for (const name of asides) expect(readFileSync(join(dirname(recordFile(repo)), name), "utf8")).toBe("{ not json");
    expect(JSON.parse(readFileSync(recordFile(repo), "utf8")).receipts.captureQuarantine.reason).toBe("incomplete-guards");
  });

  test("an unknown ledger version stays byte-identical through every refused operation", async () => {
    const { repo, e } = await enabledWithSnapshot();
    const raw = JSON.parse(readFileSync(recordFile(repo), "utf8"));
    raw.receipts = { v: 7, recordId: "x", debts: [{ since: clock - 123_456 }] };
    writeFileSync(recordFile(repo), JSON.stringify(raw));
    const before = fileHash(recordFile(repo));
    const s: ReceiptSession = { helper: HELPER, clientId: C1, clientEpoch: 1, writer: null, recordId: null, streamId: null };
    expect(errorOf(await e.receipts.openStream(repo, s, { helper: HELPER, exclusive: true, prior: null }, { id: 0, method: "openStream", vault: "v", knownRecordId: null, knownStreamId: null, nextSeq: 1, ackedThrough: 0 }))).toBe("unsupported-ledger");
    expect(errorOf(await e.receipts.apply(repo, { ...s, recordId: "a".repeat(32), streamId: "b".repeat(32) }, editReq(1, 1)))).toBe("unsupported-ledger");
    expect(errorOf(await e.receipts.status(repo, s, []))).toBe("unsupported-ledger");
    put(repo, "notes/a.md", "changed\n");
    await expect(e.capture(repo, { include: ["notes"] })).rejects.toThrow(/newer engine/);
    expect((await e.pushBackup(repo)).state).toBe("failed");
    await expect(e.noteEdit(repo, clock, { path: "notes/a.md" })).rejects.toThrow(/newer engine/);
    const status = await e.status(repo);
    expect(status.oldestUnprotectedEdit).toBe(clock - 123_456);
    expect(fileHash(recordFile(repo))).toBe(before);
    expect(readdirSync(dirname(recordFile(repo))).filter((n) => n.startsWith("deadline.json."))).toEqual([]);
  });
});

describe("exact capture proof through Git (S5, R5)", () => {
  test("captured A, then B captured and verified: A is verified at A's own snapshot; a mismatching blob keeps its debt", async () => {
    const { repo } = setup();
    const e = engine();
    await e.enable(repo);
    const s = await session(e, repo);
    const want = [{ path: "notes/a.md", doc: DOC }];
    await e.receipts.apply(repo, s, editReq(1, 1));
    expect((await e.receipts.apply(repo, s, flushReq(2, 1, 1, blobOf("A\n"))) as { ok: string }).ok).toBe("flushed");
    clock += 1000;
    const atA = await e.capture(repo, { include: ["notes"] });
    let v = await e.receipts.status(repo, s, want);
    if ("error" in v) throw new Error(v.error);
    expect(v.docs.items[0]!.state).toBe("captured");

    put(repo, "notes/a.md", "B\n");
    clock += 1000;
    const atB = await e.capture(repo, { include: ["notes"] });
    expect(atB.snapshot).not.toBe(atA.snapshot);
    expect((await e.pushBackup(repo)).state).toBe("pushed");
    expect((await e.verify(repo)).verified).toBe(true);
    v = await e.receipts.status(repo, s, want);
    if ("error" in v) throw new Error(v.error);
    expect(v.docs.items[0]!.verified).toMatchObject({ gen: 1, blobOid: blobOf("A\n"), snapshot: atA.snapshot! });
    expect(v.vault.oldestUnprotectedEdit).toBeNull();

    // A flush naming C while the disk holds D: the capture reads D, the debt and its age stay.
    await e.receipts.apply(repo, s, editReq(3, 2));
    await e.receipts.apply(repo, s, flushReq(4, 2, 3, blobOf("C\n")));
    put(repo, "notes/a.md", "D\n");
    clock += 1000;
    await e.capture(repo, { include: ["notes"] });
    await e.pushBackup(repo);
    expect((await e.verify(repo)).verified).toBe(true);
    v = await e.receipts.status(repo, s, want);
    if ("error" in v) throw new Error(v.error);
    expect(v.docs.items[0]!.proof).toMatchObject({ gen: 2, state: "mismatch" });
    expect(v.thisClient.blobDebt.count).toBe(1);
    expect(v.vault.oldestUnprotectedEdit).not.toBeNull();
    expect((await e.status(repo)).oldestUnprotectedEdit).toBe(v.vault.oldestUnprotectedEdit);
  });
});

describe("E1 review repairs: quarantine through repair, own path keys, truthful load failures", () => {
  async function published() {
    const sb = setup();
    const e = engine();
    await e.enable(sb.repo);
    const first = await e.capture(sb.repo, { include: ["notes"] });
    expect((await e.pushBackup(sb.repo)).state).toBe("pushed");
    return { ...sb, e, first };
  }
  const damageRecord = (repo: string, change: (raw: any) => void) => {
    const raw = JSON.parse(readFileSync(recordFile(repo), "utf8"));
    change(raw);
    writeFileSync(recordFile(repo), JSON.stringify(raw));
  };
  async function refusedEverywhere(repo: string, remote: string, e: Engine, snapshot: string) {
    await expect(e.capture(repo, { include: ["notes"] })).rejects.toThrow(/write guards/);
    const pushed = await e.pushBackup(repo);
    expect(pushed.state).toBe("failed");
    expect((pushed as { message: string }).message).toMatch(/write guards/);
    const prefix = backupPrefix("test-machine", await checkoutId(engineFolder(join(repo, ".git"))));
    expect(gitText(repo, ["for-each-ref", "--format=%(objectname)", prefix])).toBe(snapshot);
    expect(gitText(remote, ["for-each-ref", "--format=%(objectname)"])).toBe(snapshot);
  }

  test("F1: unrelated ledger damage on a quarantined record keeps capture and publication refused, through repeated repair and reload", async () => {
    const { repo, remote, e, first } = await published();
    const folder = engineFolder(join(repo, ".git"));
    writeFileSync(recordFile(repo), JSON.stringify(convertedRecord(JSON.parse(readFileSync(recordFile(repo), "utf8")), clock - 100, clock)));
    const damages: ((raw: any) => void)[] = [(raw) => { raw.receipts.counters.resets = "broken"; }, (raw) => { raw.receipts.counters.proofEvicted = -1; }];
    for (const [i, change] of damages.entries()) {
      damageRecord(repo, change);
      clock += 1000;
      put(repo, "notes/a.md", `partial bytes ${i} of a paused writer\n`);
      await refusedEverywhere(repo, remote, e, first.snapshot!);
      expect(storedLedger(repo).captureQuarantine).toMatchObject({ reason: "incomplete-guards" });
      // Reload without further damage leaves the repaired record as it is.
      const bytes = fileHash(recordFile(repo));
      await loadRecord(folder);
      expect(fileHash(recordFile(repo))).toBe(bytes);
    }
    expect(readdirSync(dirname(recordFile(repo))).filter((n) => n.startsWith("deadline.json.receipts-damaged-")).length).toBe(2);
  });

  test("F1: a live write whose legacy mark was lost quarantines on repair; capture and publication refuse", async () => {
    const { repo, remote, e, first } = await published();
    const s = await session(e, repo);
    expect(ticketOf(await e.receipts.apply(repo, s, editReq(1, 1)))).toBeGreaterThan(0);
    const startReq: SeqRequest = { id: 2, vault: "v", seq: 2, ackedThrough: 1, method: "noteWriteStart", path: "notes/a.md", doc: DOC, gen: 1, intent: I1, writer: WRITER, at: clock - 5 };
    expect(await e.receipts.apply(repo, s, startReq)).toMatchObject({ ok: "write-started", durable: true });
    damageRecord(repo, (raw) => { delete raw.writes["notes/a.md"]; });
    clock += 1000;
    put(repo, "notes/a.md", "partial bytes of the writer whose guard was lost\n");
    await refusedEverywhere(repo, remote, e, first.snapshot!);
    expect(storedLedger(repo).captureQuarantine).toMatchObject({ reason: "incomplete-guards" });
  });

  for (const name of ["__proto__", "constructor", "toString"]) {
    test(`F2: a durable write start on "${name}" persists its own guard and holds capture until its exact completion`, async () => {
      const { repo } = setup();
      const e = engine();
      await e.enable(repo);
      const s = await session(e, repo);
      expect(await e.receipts.apply(repo, s, { ...editReq(1, 1), path: name })).toMatchObject({ ok: "edit" });
      const startReq: SeqRequest = { id: 2, vault: "v", seq: 2, ackedThrough: 1, method: "noteWriteStart", path: name, doc: DOC, gen: 1, intent: I1, writer: WRITER, at: clock - 5 };
      const started = await e.receipts.apply(repo, s, startReq);
      expect(started).toMatchObject({ ok: "write-started", durable: true });
      const raw = JSON.parse(readFileSync(recordFile(repo), "utf8"));
      expect(Object.prototype.hasOwnProperty.call(raw.writes, name)).toBe(true);
      expect(raw.writes[name]).toMatchObject({ active: true, gen: (started as { token: number }).token, owner: { path: name, seq: 2 } });
      expect(parseRecordDetailed(raw)!.kind).toBe("ok");
      const loaded = await loadRecord(engineFolder(join(repo, ".git")));
      expect(Object.prototype.hasOwnProperty.call(loaded.writes, name) && loaded.writes[name]!.active).toBe(true);
      put(repo, name, "partial bytes of a paused writer\n");
      const held = await e.capture(repo, { include: [name] });
      expect(held.pending).toContainEqual({ path: name, reason: "writing" });
      expect(held.added).not.toContain(name);
      put(repo, name, "final\n");
      const flush: SeqRequest = { id: 3, vault: "v", seq: 3, ackedThrough: 2, method: "noteFlush", path: name, doc: DOC, gen: 1, intent: I1, editRef: 1, writeRef: 2, blobOid: blobOf("final\n") };
      expect(await e.receipts.apply(repo, s, flush)).toMatchObject({ ok: "flushed", endedWrite: true });
      clock += 1000;
      const done = await e.capture(repo, { include: [name] });
      expect(done.committed).toBe(true);
      expect(done.added).toContain(name);
      expect(gitText(repo, ["ls-tree", done.snapshot!, "--", name])).toContain(blobOf("final\n"));
      expect(storedLedger(repo).clients[C1].docs).toEqual([]);
      expect(storedLedger(repo).clients[C1].proof[0]).toMatchObject({ path: name, state: "captured", snapshot: done.snapshot });
    });
  }

  describe("F3: load-time recovery writes", () => {
    const fresh: ReceiptSession = { helper: HELPER, clientId: C1, clientEpoch: 1, writer: WRITER, recordId: null, streamId: null };
    const open = (e: Engine, repo: string) => e.receipts.openStream(repo, fresh, { helper: HELPER, exclusive: true, prior: null }, { id: 0, method: "openStream", vault: "v", knownRecordId: null, knownStreamId: null, nextSeq: 1, ackedThrough: 0 });
    const torn = (repo: string) => {
      mkdirSync(dirname(recordFile(repo)), { recursive: true });
      writeFileSync(recordFile(repo), "{ torn");
    };
    const asides = (repo: string) => readdirSync(dirname(recordFile(repo))).filter((n) => n.startsWith("deadline.json.damaged-"));
    const messageOf = (r: object) => (r as ReceiptError).message;

    test("a failure after the aside copy's temporary file opened, or after its rename, is outcome-unknown; the record is unchanged", async () => {
      for (const hook of ["afterTmpOpen", "afterRename"] as const) {
        const { repo } = setup();
        const e = engine();
        torn(repo);
        storeTestHooks[hook] = (p) => { if (p.startsWith(`${recordFile(repo)}.damaged-`)) throw new Error(`injected aside ${hook}`); };
        const reply = await open(e, repo);
        delete storeTestHooks[hook];
        expect([hook, errorOf(reply)]).toEqual([hook, "outcome-unknown"]);
        expect(messageOf(reply)).not.toMatch(/nothing was written/);
        expect(readFileSync(recordFile(repo), "utf8")).toBe("{ torn");
        expect(asides(repo).length).toBe(hook === "afterRename" ? 1 : 0);
      }
    });

    test("a failure after the replacement rename, before the folder sync, is outcome-unknown; the replacement is in place", async () => {
      const { repo } = setup();
      const e = engine();
      torn(repo);
      storeTestHooks.afterRename = (p) => { if (p === recordFile(repo)) throw new Error("injected pre-dir-fsync failure"); };
      const reply = await open(e, repo);
      delete storeTestHooks.afterRename;
      expect(errorOf(reply)).toBe("outcome-unknown");
      expect(messageOf(reply)).not.toMatch(/nothing was written/);
      expect(storedLedger(repo).captureQuarantine).toMatchObject({ reason: "incomplete-guards" });
      expect(asides(repo).length).toBe(1);
    });

    test("an aside copy made before a replacement that could not start is reported; the record is unchanged", async () => {
      const { repo } = setup();
      const e = engine();
      torn(repo);
      const dir = dirname(recordFile(repo));
      // The replacement's temporary file cannot be created once the folder is read-only.
      storeTestHooks.afterDirSync = (p) => { if (p.startsWith(`${recordFile(repo)}.damaged-`)) chmodSync(dir, 0o555); };
      let reply: object;
      try {
        reply = await open(e, repo);
      } finally {
        chmodSync(dir, 0o755);
        delete storeTestHooks.afterDirSync;
      }
      expect(errorOf(reply)).toBe("internal");
      expect(messageOf(reply)).toMatch(/copied aside \(the record itself is unchanged\)/);
      expect(messageOf(reply)).not.toMatch(/nothing was written/);
      expect(readFileSync(recordFile(repo), "utf8")).toBe("{ torn");
      expect(asides(repo).map((n) => readFileSync(join(dir, n), "utf8"))).toEqual(["{ torn"]);
    });

    test("an ordinary failure before the temporary file opened still changes nothing and frees the seq", async () => {
      const { repo } = setup();
      const e = engine();
      const s = await session(e, repo);
      await e.receipts.apply(repo, s, editReq(1, 1));
      const dir = dirname(recordFile(repo));
      const before = fileHash(recordFile(repo));
      chmodSync(dir, 0o555);
      let reply: object;
      try {
        reply = await e.receipts.apply(repo, s, editReq(2, 2));
      } finally {
        chmodSync(dir, 0o755);
      }
      expect(errorOf(reply)).toBe("internal");
      expect(messageOf(reply)).toMatch(/^nothing was written/);
      expect(fileHash(recordFile(repo))).toBe(before);
      expect(await e.receipts.apply(repo, s, editReq(2, 5))).toMatchObject({ ok: "edit" });
    });
  });
});
