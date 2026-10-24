import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backupPrefix } from "./backup-ref.ts";
import { captureWithRetry, type CaptureDeps, type RepoContext } from "./capture.ts";
import { checkoutId, engineFolder, loadRecord, saveRecord, withFolderLock } from "./engine-store.ts";
import { createGitRunner } from "./git-process.ts";
import { createBackupEngine } from "./engine.ts";
import { git, gitText, isolatedGitEnv, permissiveGuards, sandbox, type Sandbox } from "./test-fixtures.ts";
setDefaultTimeout(30_000);
const fixtures: Sandbox[] = [];
afterEach(() => { while (fixtures.length) fixtures.pop()!.cleanup(); });
async function fixture() {
  const sb = sandbox(); fixtures.push(sb);
  mkdirSync(join(sb.repo, "notes"));
  let clock = 1_000_000;
  const e = createBackupEngine({ machineId: "retry-test", now: () => clock, settleMs: 0, gitEnv: isolatedGitEnv, ...permissiveGuards });
  await e.enable(sb.repo);
  const folder = engineFolder(join(sb.repo, ".git"));
  const id = await checkoutId(folder);
  const ctx: RepoContext = { root: sb.repo, commonDir: join(sb.repo, ".git"), folder, checkoutId: id, prefix: backupPrefix("retry-test", id), objectFormat: "sha1", zeroOid: "0".repeat(40), git: createGitRunner({ hooksDir: folder.hooksDir, env: isolatedGitEnv }), cache: new Map() };
  const deps: CaptureDeps = {
    machineId: "retry-test", now: () => clock, settleMs: 0, retries: 0, maxFileBytes: 1024,
    author: { name: "Automatic backup", email: "backup@vault-sync.invalid" },
    run: (_c, signal, env) => ({ cwd: sb.repo, signal, env, timeoutMs: 10_000, maxOutputBytes: 1024 * 1024 }),
    readRecord: () => loadRecord(folder),
    persist: (_c, change) => withFolderLock(folder.recordLockDir, { waitMs: 5000 }, async () => {
      const next = change(await loadRecord(folder)); await saveRecord(folder, next); return next;
    }),
  };
  const put = (path: string, bytes: string) => writeFileSync(join(sb.repo, path), bytes, { flush: true });
  async function save(path: string, bytes: string) {
    const ticket = await e.noteEdit(sb.repo, clock, { path });
    const token = await e.noteWriteStart(sb.repo, [path]); put(path, bytes);
    await e.noteFlush(sb.repo, { upTo: ticket, paths: [path], completedWrites: [{ path, token }] });
    return { ticket, token };
  }
  const capture = (signal?: AbortSignal) => withFolderLock(folder.lockDir, { waitMs: 5000 }, () => captureWithRetry(ctx, { include: ["notes"] }, deps, signal));
  return { ...sb, e, ctx, folder, deps, put, save, capture, clock: (value: number) => { clock = value; } };
}

for (const boundary of ["before-read", "after-read"] as const) {
  for (const nextClock of [1_001_000, 1_000_000, 999_000]) test(`fresh pass recovers completed ${boundary} write with clock ${nextClock}`, async () => {
    const f = await fixture();
    for (const path of ["notes/a.md", "notes/b.md", "notes/c.md"]) await f.save(path, `base-${path}\n`);
    if (boundary === "before-read" && nextClock === 1_001_000) { f.deps.settleMs = 250; f.deps.retries = 3; }
    const readRecord = f.deps.readRecord;
    const passes: { record: Awaited<ReturnType<typeof loadRecord>>; oid: string | null }[] = [];
    const persist = f.deps.persist;
    f.deps.persist = async (ctx, change) => {
      const record = await persist(ctx, change);
      passes.push({ record, oid: record.lastCapture?.snapshot ?? null });
      return record;
    };
    let reads = 0;
    f.deps.readRecord = async (ctx) => {
      const before = await readRecord(ctx);
      if (++reads === (boundary === "before-read" ? 1 : 2)) {
        f.clock(nextClock);
        await f.save("notes/c.md", "base-notes/c.md\ncompleted-marker\n");
      }
      return boundary === "before-read" && reads === 1 ? before : readRecord(ctx);
    };
    const result = await f.capture();
    // First pass must persist a SAFE partial tree; retry must take fresh evidence for every path.
    expect(passes.length).toBe(2);
    expect(passes[0]!.record.pendingSince["notes/c.md"]).toBeDefined();
    expect(gitText(f.repo, ["ls-tree", "-r", "--name-only", passes[0]!.oid!])).not.toContain("notes/c.md");
    expect(passes[0]!.record.oldestUnprotectedEdit).toBe(Math.min(1_000_000, nextClock));
    expect(result.pending).toEqual([]);
    expect(result.startedAt).toBe(nextClock);
    for (const path of ["notes/a.md", "notes/b.md", "notes/c.md"]) {
      const expected = `base-${path}\n${path === "notes/c.md" ? "completed-marker\n" : ""}`;
      expect(git(f.repo, ["cat-file", "-p", `${result.snapshot}:${path}`])).toEqual(Buffer.from(expected));
    }
    expect(gitText(f.repo, ["rev-parse", `${result.snapshot}^`])).toBe(passes[0]!.oid!);
    // Capture and push never resolve the age; exact remote verification does.
    expect((await f.e.status(f.repo)).oldestUnprotectedEdit).toBe(Math.min(1_000_000, nextClock));
    expect((await loadRecord(f.folder)).flushed).toEqual([]);
    expect((await loadRecord(f.folder)).unflushed).toEqual([]);
    await f.e.pushBackup(f.repo);
    expect((await f.e.status(f.repo)).oldestUnprotectedEdit).toBe(Math.min(1_000_000, nextClock));
    expect((await f.e.verify(f.repo)).verified).toBe(true);
    expect(gitText(f.dir, ["--git-dir", f.remote, "rev-parse", result.ref!])).toBe(result.snapshot!);
    expect((await f.e.status(f.repo)).oldestUnprotectedEdit).toBeNull();
  });
}

test("permanent paused writer has three complete passes, retains old bytes and overdue age", async () => {
  const f = await fixture();
  await f.save("notes/a.md", "complete baseline");
  const baseline = await f.capture(); await f.e.pushBackup(f.repo); await f.e.verify(f.repo);
  const ticket = await f.e.noteEdit(f.repo, 1000, { path: "notes/a.md" });
  const token = await f.e.noteWriteStart(f.repo, ["notes/a.md"]);
  f.put("notes/a.md", "torn paused bytes");
  let reads = 0; const readRecord = f.deps.readRecord;
  f.deps.readRecord = (ctx) => { reads++; return readRecord(ctx); };
  const start = performance.now();
  const result = await f.capture();
  expect(reads).toBe(6);
  expect(performance.now() - start).toBeLessThan(2000);
  expect(result.pending).toEqual([{ path: "notes/a.md", reason: "writing" }]);
  expect(result.snapshot).toBe(baseline.snapshot);
  expect(gitText(f.repo, ["cat-file", "-p", `${result.snapshot}:notes/a.md`])).toBe("complete baseline");
  await f.e.pushBackup(f.repo); await f.e.verify(f.repo);
  expect((await f.e.status(f.repo)).oldestUnprotectedEdit).toBe(1000);
  expect((await f.e.status(f.repo)).protectionAgeSeconds).toBeGreaterThan(300);
  expect((await loadRecord(f.folder)).writes["notes/a.md"]?.gen).toBe(token);
  // Only this interval's exact completion permits the next capture to read it.
  f.put("notes/a.md", "complete recovery");
  await f.e.noteFlush(f.repo, { upTo: ticket, paths: ["notes/a.md"], completedWrites: [{ path: "notes/a.md", token }] });
  const recovered = await f.capture();
  expect(recovered.pending).toEqual([]);
  expect(gitText(f.repo, ["cat-file", "-p", `${recovered.snapshot}:notes/a.md`])).toBe("complete recovery");
});

test("the monotonic budget stops retry after a slow first pass despite a frozen edit clock", async () => {
  const f = await fixture();
  await f.e.noteEdit(f.repo, 1000, { path: "notes/a.md" });
  await f.e.noteWriteStart(f.repo, ["notes/a.md"]); f.put("notes/a.md", "partial");
  let reads = 0; const readRecord = f.deps.readRecord;
  f.deps.readRecord = async (ctx) => {
    if (++reads === 1) await new Promise((r) => setTimeout(r, 2050));
    return readRecord(ctx);
  };
  const result = await f.capture();
  expect(reads).toBe(2);
  expect(result.snapshot).toBeNull();
  expect(result.pending).toEqual([{ path: "notes/a.md", reason: "writing" }]);
  expect((await f.e.status(f.repo)).oldestUnprotectedEdit).toBe(1000);
});

test("a retry expiring during its read phase returns the last persisted pass without publishing its unproved bytes", async () => {
  const f = await fixture();
  await f.save("notes/a.md", "safe baseline");
  const baseline = await f.capture();
  await f.e.noteWriteStart(f.repo, ["notes/a.md"]);
  let reads = 0; const readRecord = f.deps.readRecord;
  f.deps.readRecord = async (ctx) => {
    if (++reads === 3) await new Promise((r) => setTimeout(r, 2050));
    return readRecord(ctx);
  };
  const result = await f.capture();
  expect(reads).toBe(3);
  expect(result.snapshot).toBe(baseline.snapshot);
  expect(result.pending).toEqual([{ path: "notes/a.md", reason: "writing" }]);
  expect((await loadRecord(f.folder)).lastCapture?.snapshot).toBe(result.snapshot!);
  expect(gitText(f.repo, ["rev-parse", result.ref!])).toBe(result.snapshot!);
});

test("cancellation interrupts the retry wait and retains the first pass pending floor", async () => {
  const f = await fixture();
  await f.e.noteEdit(f.repo, 1000, { path: "notes/a.md" });
  await f.e.noteWriteStart(f.repo, ["notes/a.md"]); f.put("notes/a.md", "partial");
  const abort = new AbortController();
  const persist = f.deps.persist; let writes = 0;
  f.deps.persist = async (ctx, change) => {
    const record = await persist(ctx, change); writes++;
    setTimeout(() => abort.abort(), 20);
    return record;
  };
  let reads = 0; const readRecord = f.deps.readRecord;
  f.deps.readRecord = (ctx) => { reads++; return readRecord(ctx); };
  const start = performance.now();
  await expect(f.capture(abort.signal)).rejects.toThrow();
  expect(performance.now() - start).toBeLessThan(1000);
  expect(reads).toBe(2); expect(writes).toBe(1);
  expect((await f.e.status(f.repo)).oldestUnprotectedEdit).toBe(1000);
  expect((await loadRecord(f.folder)).pendingSince["notes/a.md"]).toBeDefined();
});

test("too-large pending alone does not retry and a late acknowledgement earns no earlier credit", async () => {
  const f = await fixture();
  f.put("notes/large.md", "x".repeat(2048));
  const ticket = await f.e.noteEdit(f.repo, 1000, { path: "notes/large.md" });
  const readRecord = f.deps.readRecord; let reads = 0;
  f.deps.readRecord = async (ctx) => {
    if (++reads === 2) await f.e.noteFlush(f.repo, { upTo: ticket, paths: ["notes/large.md"] });
    return readRecord(ctx);
  };
  const result = await f.capture();
  expect(reads).toBe(2);
  expect(result.pending).toEqual([{ path: "notes/large.md", reason: "too-large" }]);
  expect((await loadRecord(f.folder)).flushed).toMatchObject([{ path: "notes/large.md", from: 1000 }]);
  expect((await f.e.status(f.repo)).oldestUnprotectedEdit).toBe(1000);
});

test("unstable pending recovers after a fresh pass without changing settling criteria", async () => {
  const f = await fixture();
  await f.save("notes/a.md", "settles on retry");
  f.deps.settleMs = 50; f.deps.retries = 0;
  const readRecord = f.deps.readRecord; let reads = 0;
  f.deps.readRecord = (ctx) => { reads++; return readRecord(ctx); };
  const result = await f.capture();
  expect(reads).toBe(4);
  expect(result.pending).toEqual([]);
  expect(gitText(f.repo, ["cat-file", "-p", `${result.snapshot}:notes/a.md`])).toBe("settles on retry");
});
