import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createBackupEngine } from "./index.ts";
import { emptyRecord, noteFlush, noteWriteStart } from "./deadline.ts";
import { backupPrefix } from "./backup-ref.ts";
import { captureSnapshot, type CaptureDeps, type RepoContext } from "./capture.ts";
import { checkoutId, engineFolder, ensureEngineFolder, loadRecord, saveRecord, withFolderLock } from "./engine-store.ts";
import { createGitRunner } from "./git-process.ts";
import { gitText, isolatedGitEnv, permissiveGuards, sandbox, type Sandbox } from "./test-fixtures.ts";

setDefaultTimeout(30_000);
const fixtures: Sandbox[] = [];
afterEach(() => { while (fixtures.length) fixtures.pop()!.cleanup(); });
function setup() { const s = sandbox(); fixtures.push(s); return s; }
function put(repo: string, path: string, bytes: string) {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), bytes, { flush: true });
}
function engine(now = () => 1_000_000) {
  return createBackupEngine({ machineId: "test-machine", settleMs: 0, now, gitEnv: isolatedGitEnv, ...permissiveGuards });
}
async function backup(e: ReturnType<typeof engine>, repo: string) {
  const c = await e.capture(repo, { include: ["notes"] });
  await e.pushBackup(repo);
  expect((await e.verify(repo)).verified).toBe(true);
  return c;
}

describe("exact write interval receipts", () => {
  for (const rollback of [false, true]) test(`old receipts cannot finish a newer paused writer (${rollback ? "rolled back" : "equal"} clocks)`, async () => {
    const { repo, remote, dir } = setup();
    let clock = 1_000_000;
    const e = engine(() => clock);
    put(repo, "notes/a.md", "baseline");
    await e.enable(repo);
    await backup(e, repo);
    const first = await e.noteEdit(repo, clock, { path: "notes/a.md" });
    const firstWrite = await e.noteWriteStart(repo, ["notes/a.md"]);
    put(repo, "notes/a.md", "first complete");
    const oldReceipt = { upTo: first, paths: ["notes/a.md"], completedWrites: [{ path: "notes/a.md", token: firstWrite }] };
    await e.noteFlush(repo, oldReceipt);
    if (rollback) clock -= 1000;
    const second = await e.noteEdit(repo, clock, { path: "notes/a.md" });
    const secondWrite = await e.noteWriteStart(repo, ["notes/a.md"]);
    expect(secondWrite).not.toBe(firstWrite);
    put(repo, "notes/a.md", "partial second");
    await e.noteFlush(repo, oldReceipt);
    // A receipt without an interval identity cannot end an active interval either.
    await e.noteFlush(repo, { upTo: first, allDocuments: true });
    const paused = await backup(e, repo);
    expect(paused.pending).toContainEqual({ path: "notes/a.md", reason: "writing" });
    expect(gitText(dir, ["--git-dir", remote, "cat-file", "-p", `${paused.snapshot}:notes/a.md`])).toBe("baseline");
    expect((await e.status(repo)).writing).toEqual(["notes/a.md"]);
    // A restart uses the persisted identity; only the current interval's completion unblocks capture.
    const restarted = engine(() => clock);
    put(repo, "notes/a.md", "second complete");
    const receipt = { upTo: second, paths: ["notes/a.md"], completedWrites: [{ path: "notes/a.md", token: secondWrite }] };
    await restarted.noteFlush(repo, receipt);
    await restarted.noteFlush(repo, receipt);
    const done = await backup(restarted, repo);
    expect(gitText(repo, ["cat-file", "-p", `${done.snapshot}:notes/a.md`])).toBe("second complete");
    expect((await restarted.status(repo)).oldestUnprotectedEdit).toBeNull();
  });

  test("path and all-document receipts only end explicitly matching intervals", async () => {
    const { repo } = setup();
    const e = engine();
    const a = await e.noteWriteStart(repo, ["notes/a.md", "notes/b.md"]);
    const c = await e.noteWriteStart(repo, ["notes/c.md"]);
    await e.noteFlush(repo, { upTo: 0, paths: ["notes/a.md"], completedWrites: [{ path: "notes/b.md", token: a }, { path: "notes/a.md", token: c }] });
    expect((await e.status(repo)).writing.sort()).toEqual(["notes/a.md", "notes/b.md", "notes/c.md"]);
    await e.noteFlush(repo, { upTo: 0, allDocuments: true, completedWrites: [{ path: "notes/a.md", token: a }, { path: "notes/c.md", token: a }] });
    expect((await e.status(repo)).writing.sort()).toEqual(["notes/b.md", "notes/c.md"]);
    await e.noteFlush(repo, { upTo: 0, allDocuments: true, completedWrites: [{ path: "notes/b.md", token: a }, { path: "notes/c.md", token: c }] });
    expect((await e.status(repo)).writing).toEqual([]);
  });

  test("invalid completion identities fail without finishing the writer", async () => {
    const { repo } = setup();
    const e = engine();
    await e.noteWriteStart(repo, ["notes/a.md"]);
    for (const token of [0, -1, NaN, 1.5, 999]) {
      await expect(e.noteFlush(repo, { upTo: 0, paths: ["notes/a.md"], completedWrites: [{ path: "notes/a.md", token }] })).rejects.toThrow();
    }
    await expect(e.noteFlush(repo, { upTo: 0, allDocuments: true, completedWrites: [{ path: "../a.md", token: 1 }] })).rejects.toThrow();
    expect((await e.status(repo)).writing).toEqual(["notes/a.md"]);
  });

  test("overlapping starts cannot overwrite an unfinished interval", () => {
    const r = noteWriteStart(emptyRecord(), ["a.md"], 100);
    expect(() => noteWriteStart(r, ["b.md", "a.md"], 100)).toThrow();
    const done = noteFlush(r, { upTo: 0, paths: ["a.md"], completedWrites: [{ path: "a.md", token: r.generation }] }, 100);
    expect(done.writes["a.md"]?.active).toBe(false);
  });
});

describe("exact absence of acknowledged paths", () => {
  test("create and delete between captures resolves only after verification, including a missing ancestor", async () => {
    const { repo } = setup();
    const e = engine();
    put(repo, "notes/kept.md", "kept");
    await e.enable(repo);
    const baseline = await backup(e, repo);
    for (const path of ["notes/new.md", "notes/new-folder/new.md"]) {
      const ticket = await e.noteEdit(repo, 1000, { path });
      put(repo, path, "temporary");
      rmSync(join(repo, path));
      if (path.includes("new-folder")) rmSync(dirname(join(repo, path)), { recursive: true });
      await e.noteFlush(repo, { upTo: ticket, paths: [path] });
      const c = await e.capture(repo, { include: ["notes"] });
      expect(c.committed).toBe(false);
      expect(c.snapshot).toBe(baseline.snapshot);
      expect((await e.status(repo)).oldestUnprotectedEdit).toBe(1000);
      await e.pushBackup(repo);
      expect((await e.verify(repo)).verified).toBe(true);
      expect((await e.status(repo)).oldestUnprotectedEdit).toBeNull();
    }
  });

  test("a newer edit after deletion stays unprotected", async () => {
    const { repo } = setup();
    const e = engine();
    put(repo, "notes/kept.md", "kept");
    await e.enable(repo);
    await backup(e, repo);
    const ticket = await e.noteEdit(repo, 1000, { path: "notes/new.md" });
    await e.noteFlush(repo, { upTo: ticket, paths: ["notes/new.md"] });
    await e.noteEdit(repo, 2000, { path: "notes/new.md" });
    await backup(e, repo);
    expect((await e.status(repo)).oldestUnprotectedEdit).toBe(2000);
  });

  test("an excluded absent path is not deletion coverage", async () => {
    const { repo } = setup();
    const e = engine();
    put(repo, "notes/kept.md", "kept");
    await e.enable(repo);
    await backup(e, repo);
    const ticket = await e.noteEdit(repo, 1000, { path: "notes/excluded.md" });
    await e.noteFlush(repo, { upTo: ticket, paths: ["notes/excluded.md"] });
    await e.capture(repo, { include: ["notes"], exclude: ["notes/excluded.md"] });
    await e.pushBackup(repo);
    expect((await e.verify(repo)).verified).toBe(true);
    expect((await e.status(repo)).oldestUnprotectedEdit).toBe(1000);
  });

  test("symlinked ancestors cannot prove an absent path", async () => {
    const { repo, dir } = setup();
    const e = engine();
    put(repo, "notes/kept.md", "kept");
    await e.enable(repo);
    await backup(e, repo);
    const target = join(dir, "outside");
    mkdirSync(target);
    symlinkSync(target, join(repo, "notes/link"));
    const ticket = await e.noteEdit(repo, 1000, { path: "notes/link/absent.md" });
    await e.noteFlush(repo, { upTo: ticket, paths: ["notes/link/absent.md"] });
    await backup(e, repo);
    expect((await e.status(repo)).oldestUnprotectedEdit).toBe(1000);
  });

  test.if(process.platform !== "win32" && process.getuid?.() !== 0)("an unreadable ancestor cannot prove deletion; restored access permits proof", async () => {
    const { repo } = setup();
    const e = engine();
    put(repo, "notes/kept.md", "kept");
    mkdirSync(join(repo, "notes/hidden"));
    await e.enable(repo);
    await backup(e, repo);
    const ticket = await e.noteEdit(repo, 1000, { path: "notes/hidden/absent.md" });
    await e.noteFlush(repo, { upTo: ticket, paths: ["notes/hidden/absent.md"] });
    chmodSync(join(repo, "notes/hidden"), 0);
    try {
      const c = await backup(e, repo);
      expect(c.pending).toContainEqual({ path: "notes/hidden/absent.md", reason: "unreadable" });
      expect((await e.status(repo)).oldestUnprotectedEdit).not.toBeNull();
    } finally { chmodSync(join(repo, "notes/hidden"), 0o755); }
    await backup(e, repo);
    expect((await e.status(repo)).oldestUnprotectedEdit).toBeNull();
  });
});

// The dependency hook schedules a real writer after absence checks and before the second record read.
async function captureWithWriter(repo: string, writer: () => Promise<void>) {
  const folder = engineFolder(join(repo, ".git"));
  await ensureEngineFolder(folder);
  const id = await checkoutId(folder);
  const ctx: RepoContext = { root: repo, commonDir: join(repo, ".git"), folder, checkoutId: id, prefix: backupPrefix("test-machine", id), objectFormat: "sha1", zeroOid: "0".repeat(40), git: createGitRunner({ hooksDir: folder.hooksDir, env: isolatedGitEnv }), cache: new Map() };
  let reads = 0;
  const deps: CaptureDeps = {
    machineId: "test-machine", now: () => 1_000_000, settleMs: 0, retries: 0, maxFileBytes: 1024,
    author: { name: "Automatic backup", email: "backup@vault-sync.invalid" },
    run: (_c, signal, env) => ({ cwd: repo, timeoutMs: 10_000, maxOutputBytes: 1024 * 1024, signal, env }),
    readRecord: async () => { if (++reads === 2) await writer(); return loadRecord(folder); },
    persist: (_c, change) => withFolderLock(folder.recordLockDir, { waitMs: 5000 }, async () => {
      const next = change(await loadRecord(folder));
      await saveRecord(folder, next);
      return next;
    }),
  };
  return withFolderLock(folder.lockDir, { waitMs: 5000 }, () => captureSnapshot(ctx, { include: ["notes"] }, deps));
}

describe("deletion proof ordering and boundaries", () => {
  for (const complete of [false, true]) test(`a writer ${complete ? "completed" : "still active"} during absence proof invalidates that proof`, async () => {
    const { repo } = setup();
    const e = engine();
    put(repo, "notes/kept.md", "kept");
    await e.enable(repo);
    await backup(e, repo);
    const ticket = await e.noteEdit(repo, 1000, { path: "notes/new.md" });
    await e.noteFlush(repo, { upTo: ticket, paths: ["notes/new.md"] });
    let token = 0;
    const c = await captureWithWriter(repo, async () => {
      token = await e.noteWriteStart(repo, ["notes/new.md"]);
      if (complete) await e.noteFlush(repo, { upTo: ticket, paths: ["notes/new.md"], completedWrites: [{ path: "notes/new.md", token }] });
    });
    expect(c.pending).toContainEqual({ path: "notes/new.md", reason: "writing" });
    await e.pushBackup(repo);
    expect((await e.verify(repo)).verified).toBe(true);
    expect((await e.status(repo)).oldestUnprotectedEdit).not.toBeNull();
    if (!complete) await e.noteFlush(repo, { upTo: ticket, paths: ["notes/new.md"], completedWrites: [{ path: "notes/new.md", token }] });
    const next = await backup(e, repo);
    expect(next.pending).toEqual([]);
    expect((await e.status(repo)).oldestUnprotectedEdit).toBeNull();
  });

  test("an active deletion interval keeps the previous snapshot until its matching completion", async () => {
    const { repo } = setup();
    const e = engine();
    put(repo, "notes/kept.md", "kept");
    put(repo, "notes/deleted.md", "previous complete");
    await e.enable(repo);
    await backup(e, repo);
    const ticket = await e.noteEdit(repo, 1000, { path: "notes/deleted.md" });
    const token = await e.noteWriteStart(repo, ["notes/deleted.md"]);
    rmSync(join(repo, "notes/deleted.md"));
    // This reports edit coverage but carries no authority to end the active interval.
    await e.noteFlush(repo, { upTo: ticket, paths: ["notes/deleted.md"] });
    const paused = await backup(e, repo);
    expect(paused.removed).toEqual([]);
    expect(paused.pending).toContainEqual({ path: "notes/deleted.md", reason: "writing" });
    expect(gitText(repo, ["cat-file", "-p", `${paused.snapshot}:notes/deleted.md`])).toBe("previous complete");
    await e.noteFlush(repo, { upTo: ticket, paths: ["notes/deleted.md"], completedWrites: [{ path: "notes/deleted.md", token }] });
    const done = await backup(e, repo);
    expect(done.removed).toEqual(["notes/deleted.md"]);
    expect((await e.status(repo)).oldestUnprotectedEdit).toBeNull();
  });

  for (const boundary of ["nested", "directory"]) test(`an absent path at a ${boundary} boundary does not resolve its obligation`, async () => {
    const { repo } = setup();
    const e = engine();
    put(repo, "notes/kept.md", "kept");
    await e.enable(repo);
    await backup(e, repo);
    const path = boundary === "nested" ? "notes/nested/absent.md" : "notes/directory.md";
    if (boundary === "nested") mkdirSync(join(repo, "notes/nested/.git"), { recursive: true });
    else mkdirSync(join(repo, path));
    const ticket = await e.noteEdit(repo, 1000, { path });
    await e.noteFlush(repo, { upTo: ticket, paths: [path] });
    await backup(e, repo);
    expect((await e.status(repo)).oldestUnprotectedEdit).toBe(1000);
  });
});


describe("initial empty scoped snapshot", () => {
  for (const committedHead of [true, false]) test(`first exact deletion is remotely verifiable with ${committedHead ? "committed" : "unborn"} user HEAD`, async () => {
    const { repo, remote, dir } = setup();
    let e = engine();
    await e.enable(repo);
    const ticket = await e.noteEdit(repo, 1000, { path: "notes/new.md" });
    put(repo, "notes/new.md", "temporary user content");
    if (committedHead) {
      gitText(repo, ["add", "notes/new.md"]);
      gitText(repo, ["commit", "-qm", "synthetic user document"]);
    }
    rmSync(join(repo, "notes/new.md"));
    // Unrelated staged intent and newer worktree bytes must survive the private empty index.
    put(repo, "outside.txt", "staged user bytes");
    gitText(repo, ["add", "outside.txt"]);
    put(repo, "outside.txt", "unstaged user bytes");
    const headFile = readFileSync(join(repo, ".git/HEAD"));
    const head = committedHead ? gitText(repo, ["rev-parse", "HEAD"]) : null;
    const index = readFileSync(join(repo, ".git/index"));
    await e.noteFlush(repo, { upTo: ticket, paths: ["notes/new.md"] });
    const first = await e.capture(repo, { include: ["notes"] });
    expect(first.committed).toBe(true);
    expect(first.snapshot).not.toBeNull();
    expect(first.pending).toEqual([]);
    expect(first.added).toEqual([]);
    expect(first.removed).toEqual([]);
    const snapshot = first.snapshot!;
    expect(gitText(repo, ["ls-tree", "-r", snapshot])).toBe("");
    expect(gitText(repo, ["rev-list", "--parents", snapshot])).toBe(snapshot);
    const folder = engineFolder(join(repo, ".git"));
    expect(JSON.parse(readFileSync(folder.chainFile, "utf8")).roots).toContain(snapshot);
    expect((await e.status(repo)).oldestUnprotectedEdit).toBe(1000);
    expect((await e.verify(repo)).verified).toBe(false);
    // Restart before push and verification: the obligation must remain durable.
    e = engine();
    expect((await e.status(repo)).oldestUnprotectedEdit).toBe(1000);
    expect((await e.pushBackup(repo)).state).toBe("pushed");
    expect((await e.status(repo)).oldestUnprotectedEdit).toBe(1000);
    expect((await e.verify(repo)).verified).toBe(true);
    expect(gitText(dir, ["--git-dir", remote, "rev-parse", first.ref!])).toBe(snapshot);
    expect(gitText(dir, ["--git-dir", remote, "ls-tree", "-r", snapshot])).toBe("");
    expect(gitText(dir, ["--git-dir", remote, "rev-list", "--all"])).toBe(snapshot);
    expect((await e.status(repo)).oldestUnprotectedEdit).toBeNull();
    // A later exact deletion uses the same real remote object without another empty commit.
    for (let i = 0; i < 2; i++) {
      e = engine();
      const t = await e.noteEdit(repo, 2000 + i, { path: "notes/new.md" });
      await e.noteFlush(repo, { upTo: t, paths: ["notes/new.md"] });
      const repeated = await e.capture(repo, { include: ["notes"] });
      expect(repeated.committed).toBe(false);
      expect(repeated.snapshot).toBe(snapshot);
      expect((await e.status(repo)).oldestUnprotectedEdit).toBe(2000 + i);
      await e.pushBackup(repo);
      expect((await e.verify(repo)).verified).toBe(true);
      expect((await e.status(repo)).oldestUnprotectedEdit).toBeNull();
    }
    expect(readFileSync(join(repo, ".git/index"))).toEqual(index);
    expect(readFileSync(join(repo, ".git/HEAD"))).toEqual(headFile);
    if (head) expect(gitText(repo, ["rev-parse", "HEAD"])).toBe(head);
    else expect(existsSync(join(repo, ".git/refs/heads/main"))).toBe(false);
    expect(readFileSync(join(repo, "outside.txt"), "utf8")).toBe("unstaged user bytes");
    expect(existsSync(join(repo, "notes/new.md"))).toBe(false);
  });

  test("an empty vault without acknowledged absence creates no snapshot", async () => {
    const { repo } = setup();
    const e = engine();
    await e.enable(repo);
    for (let i = 0; i < 2; i++) {
      expect((await e.capture(repo, { include: ["notes"] })).snapshot).toBeNull();
      expect((await e.pushBackup(repo)).state).toBe("no-snapshot");
      expect((await e.verify(repo)).verified).toBe(false);
    }
    expect((await e.status(repo)).oldestUnprotectedEdit).toBeNull();
  });

  test("an active absent writer cannot be cleared by an empty listing or another deletion's snapshot", async () => {
    const { repo } = setup();
    const e = engine();
    await e.enable(repo);
    const ticket = await e.noteEdit(repo, 1000, { path: "notes/active.md" });
    const token = await e.noteWriteStart(repo, ["notes/active.md"]);
    await e.noteFlush(repo, { upTo: ticket, paths: ["notes/active.md"] });
    const blocked = await e.capture(repo, { include: ["notes"] });
    expect(blocked.snapshot).toBeNull();
    expect(blocked.pending).toContainEqual({ path: "notes/active.md", reason: "writing" });
    const gone = await e.noteEdit(repo, 2000, { path: "notes/gone.md" });
    await e.noteFlush(repo, { upTo: gone, allDocuments: true });
    const mixed = await backup(e, repo);
    expect(mixed.snapshot).not.toBeNull();
    expect((await e.status(repo)).oldestUnprotectedEdit).toBe(1000);
    expect((await e.status(repo)).writing).toEqual(["notes/active.md"]);
    await e.noteFlush(repo, { upTo: gone, paths: ["notes/active.md"], completedWrites: [{ path: "notes/active.md", token }] });
    await backup(engine(), repo);
    expect((await e.status(repo)).oldestUnprotectedEdit).toBeNull();
  });

  test.if(process.platform !== "win32" && process.getuid?.() !== 0)("an empty unreadable subtree stays uncertain beside the initial absence snapshot", async () => {
    const { repo } = setup();
    const e = engine();
    await e.enable(repo);
    mkdirSync(join(repo, "notes/hidden"), { recursive: true });
    const hidden = await e.noteEdit(repo, 1000, { path: "notes/hidden/absent.md" });
    await e.noteFlush(repo, { upTo: hidden, paths: ["notes/hidden/absent.md"] });
    chmodSync(join(repo, "notes/hidden"), 0);
    try {
      const blocked = await e.capture(repo, { include: ["notes"] });
      expect(blocked.snapshot).toBeNull();
      expect(blocked.pending).toContainEqual({ path: "notes/hidden", reason: "unlisted" });
      const gone = await e.noteEdit(repo, 2000, { path: "notes/gone.md" });
      await e.noteFlush(repo, { upTo: gone, allDocuments: true });
      const mixed = await backup(e, repo);
      expect(mixed.snapshot).not.toBeNull();
      expect(mixed.pending).toContainEqual({ path: "notes/hidden", reason: "unlisted" });
      expect((await e.status(repo)).oldestUnprotectedEdit).toBe(1000);
    } finally { chmodSync(join(repo, "notes/hidden"), 0o755); }
    await backup(engine(), repo);
    expect((await e.status(repo)).oldestUnprotectedEdit).toBeNull();
  });

  test("acknowledgements after capture start stay outstanding when an initial empty snapshot is created", async () => {
    const { repo } = setup();
    const e = engine();
    await e.enable(repo);
    const first = await e.noteEdit(repo, 2000, { path: "notes/first.md" });
    await e.noteFlush(repo, { upTo: first, paths: ["notes/first.md"] });
    const late = await e.noteEdit(repo, 1000, { path: "notes/late.md" });
    const c = await captureWithWriter(repo, () => e.noteFlush(repo, { upTo: late, paths: ["notes/late.md"] }));
    expect(c.committed).toBe(true);
    await e.pushBackup(repo);
    expect((await e.verify(repo)).verified).toBe(true);
    expect((await e.status(repo)).oldestUnprotectedEdit).toBe(1000);
    const next = await backup(engine(), repo);
    expect(next.committed).toBe(false);
    expect(next.snapshot).toBe(c.snapshot);
    expect((await e.status(repo)).oldestUnprotectedEdit).toBeNull();
  });
});
