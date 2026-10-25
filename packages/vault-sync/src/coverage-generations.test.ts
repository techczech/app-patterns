import { setDefaultTimeout, afterEach, describe, expect, test } from "bun:test";
setDefaultTimeout(30_000);
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { backupPrefix } from "./backup-ref.ts";
import { captureSnapshot, type CaptureDeps, type RepoContext } from "./capture.ts";
import { checkoutId, engineFolder, ensureEngineFolder, loadRecord, saveRecord, withFolderLock } from "./engine-store.ts";
import { createGitRunner } from "./git-process.ts";
import { createBackupEngine, type BackupEngineOptions } from "./index.ts";
import { gitText, isolatedGitEnv, permissiveGuards, sandbox, type Sandbox } from "./test-fixtures.ts";

/** Review round 2, R4–R8: coverage is ordered by generations, scoped by path, and never overstated. */

const sandboxes: Sandbox[] = [];
afterEach(() => {
  while (sandboxes.length) sandboxes.pop()!.cleanup();
});

function setup(): Sandbox {
  const sb = sandbox();
  sandboxes.push(sb);
  return sb;
}

function engine(overrides: Partial<BackupEngineOptions> = {}) {
  return createBackupEngine({ machineId: "test-machine", settleMs: 0, gitEnv: isolatedGitEnv, ...permissiveGuards, ...overrides });
}

/** Writes and syncs a file, as a coordinated writer does before acknowledging. */
function put(root: string, path: string, content: string): void {
  const abs = join(root, ...path.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  const fd = openSync(abs, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

async function backUp(e: ReturnType<typeof engine>, repo: string) {
  const captured = await e.capture(repo, { include: ["notes"] });
  const pushed = await e.pushBackup(repo);
  const verified = await e.verify(repo);
  return { captured, pushed, verified, status: await e.status(repo) };
}

const blobAt = (repo: string, snapshot: string, path: string) => gitText(repo, ["cat-file", "-p", `${snapshot}:${path}`]);
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const posix = process.platform !== "win32";

describe("a coordinated write that starts and finishes while a capture reads (R4)", () => {
  for (const sameClock of [false, true]) {
    test(`is not captured and stays unprotected (${sameClock ? "same" : "later"} clock)`, async () => {
      const { repo } = setup();
      put(repo, "notes/a.md", "complete old");
      let clock = 1_000_000;
      const e = engine({ now: () => clock });
      await e.enable(repo);
      await backUp(e, repo);
      clock += 1000;

      // Capture through its module, scheduling the writer between its two record reads: after the first,
      // the writer starts and writes partial bytes (which the capture reads); before the second returns,
      // it finishes, syncs and acknowledges.
      const folder = engineFolder(join(repo, ".git"));
      await ensureEngineFolder(folder);
      const id = await checkoutId(folder);
      const git = createGitRunner({ hooksDir: folder.hooksDir, env: isolatedGitEnv });
      const ctx: RepoContext = { root: repo, commonDir: join(repo, ".git"), folder, checkoutId: id, prefix: backupPrefix("test-machine", id), objectFormat: "sha1", zeroOid: "0".repeat(40), git, cache: new Map() };
      let reads = 0;
      let ticket = 0;
      let writeToken = 0;
      const deps: CaptureDeps = {
        machineId: "test-machine", now: () => clock, settleMs: 0, retries: 0, maxFileBytes: 1024, author: { name: "Automatic backup", email: "backup@vault-sync.invalid" },
        run: (_c, signal, env) => ({ cwd: repo, timeoutMs: 10_000, maxOutputBytes: 1024 * 1024, signal, env }),
        readRecord: async () => {
          const record = await loadRecord(folder);
          reads += 1;
          if (reads === 1) {
            ticket = await e.noteEdit(repo, clock, { path: "notes/a.md" });
            writeToken = await e.noteWriteStart(repo, ["notes/a.md"]);
            put(repo, "notes/a.md", "partial");
            return record;
          }
          if (!sameClock) clock += 1000;
          put(repo, "notes/a.md", "complete final");
          await e.noteFlush(repo, { upTo: ticket, paths: ["notes/a.md"], completedWrites: [{ path: "notes/a.md", token: writeToken }] });
          return loadRecord(folder);
        },
        persist: (_c, change) => withFolderLock(folder.recordLockDir, { waitMs: 5000 }, async () => {
          const next = change(await loadRecord(folder));
          await saveRecord(folder, next);
          return next;
        }),
      };
      const captured = await withFolderLock(folder.lockDir, { waitMs: 5000 }, () => captureSnapshot(ctx, { include: ["notes"] }, deps));
      expect(captured.pending).toEqual([{ path: "notes/a.md", reason: "writing" }]);
      expect(captured.committed).toBe(false);
      expect(blobAt(repo, captured.snapshot!, "notes/a.md")).toBe("complete old");
      await e.pushBackup(repo);
      expect((await e.verify(repo)).verified).toBe(true);
      let status = await e.status(repo);
      expect(status.oldestUnprotectedEdit).not.toBeNull();
      expect(status.oldestUnprotectedEdit!).toBeLessThanOrEqual(1_001_000);

      // The next capture reads the finished bytes, and its verification protects them.
      const next = await backUp(e, repo);
      expect(blobAt(repo, next.captured.snapshot!, "notes/a.md")).toBe("complete final");
      status = next.status;
      expect(status.oldestUnprotectedEdit).toBeNull();
    });
  }
});

describe("acknowledgements are per document (R8)", () => {
  test("saving one document does not protect another document's unsaved edit", async () => {
    const { repo } = setup();
    put(repo, "notes/a.md", "saved a");
    put(repo, "notes/b.md", "saved b");
    let clock = 1_000_000;
    const e = engine({ now: () => clock });
    await e.enable(repo);
    await backUp(e, repo);
    clock += 1000;
    const editA = clock;
    const ticketA = await e.noteEdit(repo, clock, { path: "notes/a.md" });
    clock += 1000;
    const ticketB = await e.noteEdit(repo, clock, { path: "notes/b.md" });
    const writeToken = await e.noteWriteStart(repo, ["notes/b.md"]);
    put(repo, "notes/b.md", "new saved b");
    await e.noteFlush(repo, { upTo: ticketB, paths: ["notes/b.md"], completedWrites: [{ path: "notes/b.md", token: writeToken }] });
    clock += 1000;
    let r = await backUp(e, repo);
    expect(r.verified.verified).toBe(true);
    expect(blobAt(repo, r.captured.snapshot!, "notes/a.md")).toBe("saved a");
    expect(r.status.oldestUnprotectedEdit).toBe(editA);
    expect(r.status.unflushedEditSince).toBe(editA);

    // A's own save, captured after its acknowledgement and verified, protects it.
    put(repo, "notes/a.md", "new saved a");
    await e.noteFlush(repo, { upTo: ticketA, paths: ["notes/a.md"] });
    clock += 1000;
    r = await backUp(e, repo);
    expect(blobAt(repo, r.captured.snapshot!, "notes/a.md")).toBe("new saved a");
    expect(r.status.oldestUnprotectedEdit).toBeNull();
  });

  test("an edit reported without a path is not covered by one document's save", async () => {
    const { repo } = setup();
    put(repo, "notes/a.md", "saved a");
    put(repo, "notes/b.md", "saved b");
    let clock = 1_000_000;
    const e = engine({ now: () => clock });
    await e.enable(repo);
    await backUp(e, repo);
    clock += 1000;
    const wide = clock;
    await e.noteEdit(repo, clock);
    clock += 1000;
    const ticketB = await e.noteEdit(repo, clock, { path: "notes/b.md" });
    put(repo, "notes/b.md", "new saved b");
    await e.noteFlush(repo, { upTo: ticketB, paths: ["notes/b.md"] });
    clock += 1000;
    let r = await backUp(e, repo);
    expect(r.status.oldestUnprotectedEdit).toBe(wide);
    // Acknowledging every document covers it.
    await e.noteFlush(repo, { upTo: ticketB, allDocuments: true });
    clock += 1000;
    r = await backUp(e, repo);
    expect(r.status.oldestUnprotectedEdit).toBeNull();
    await expect(e.noteFlush(repo, { through: 5 } as never)).rejects.toThrow();
  });
});

describe("a folder that cannot be listed (R5)", () => {
  test.if(posix && !isRoot)("is pending even when no file in it was ever captured, and restore does not report the backup complete", async () => {
    const { repo } = setup();
    put(repo, "notes/a.md", "old");
    let clock = 1_000_000;
    const e = engine({ now: () => clock });
    await e.enable(repo);
    await backUp(e, repo);
    clock += 1000;
    put(repo, "notes/new/unsent.md", "never backed up");
    const hidden = join(repo, "notes", "new");
    chmodSync(hidden, 0);
    try {
      clock += 600_000;
      put(repo, "notes/a.md", "changed");
      const r = await backUp(e, repo);
      expect(r.verified.verified).toBe(true);
      expect(r.captured.pending).toEqual([{ path: "notes/new", reason: "unlisted" }]);
      expect(r.status.unlistedFolders).toEqual(["notes/new"]);
      // Unknown since the engine last looked.
      expect(r.status.oldestUnprotectedEdit).toBe(1_000_000);
      const [entry] = await e.listBackups(repo);
      expect(entry).toMatchObject({ coverage: "recorded", protectedThrough: 1_000_000, pendingFiles: 1, unlistedFolders: 1 });
    } finally {
      chmodSync(hidden, 0o755);
    }
    clock += 60_000;
    const readable = await backUp(e, repo);
    expect(blobAt(repo, readable.captured.snapshot!, "notes/new/unsent.md")).toBe("never backed up");
    expect(readable.status.unlistedFolders).toEqual([]);
    expect(readable.status.oldestUnprotectedEdit).toBeNull();
  });
});

describe("a confirmed deletion (R7)", () => {
  test("covers an acknowledged edit of the deleted path", async () => {
    const { repo } = setup();
    put(repo, "notes/a.md", "old");
    put(repo, "notes/b.md", "kept");
    let clock = 1_000_000;
    const e = engine({ now: () => clock });
    await e.enable(repo);
    await backUp(e, repo);
    clock += 1000;
    const ticket = await e.noteEdit(repo, clock, { path: "notes/a.md" });
    rmSync(join(repo, "notes", "a.md"));
    await e.noteFlush(repo, { upTo: ticket, paths: ["notes/a.md"] });
    clock += 60_000;
    const r = await backUp(e, repo);
    expect(r.captured.removed).toEqual(["notes/a.md"]);
    expect(r.verified.verified).toBe(true);
    expect(r.status.oldestUnprotectedEdit).toBeNull();
  });
});

describe("an older deadline record (R6)", () => {
  test("keeps its oldest edit across conversion and restart, and is not cleared by an ordinary backup", async () => {
    const { repo } = setup();
    put(repo, "notes/a.md", "a");
    const e = engine();
    await e.enable(repo);
    const folder = engineFolder(join(repo, ".git"));
    const oldest = Date.now() - 600_000;
    writeFileSync(folder.recordFile, JSON.stringify({ schema: 1, oldestUnprotectedEdit: oldest, latestEditNoted: oldest, lastVerifiedSnapshot: null, lastVerifiedAt: null, protectedThrough: null, lastCapture: null, lastPushed: null, pendingSince: {}, lastError: null }));

    let status = await engine().status(repo);
    expect(status.oldestUnprotectedEdit).toBe(oldest);
    expect(status.protectionAgeSeconds).toBeGreaterThanOrEqual(600);
    expect(status.recoveredFromDamagedRecord).toBe(true);
    expect(readdirSync(join(repo, ".git", "vault-sync")).some((n) => n.startsWith("deadline.json.converted-"))).toBe(true);

    // Its write guards cannot be proved complete, so after a restart capture stays refused (editor
    // receipts contract §11), an all-documents acknowledgement does not lift that, and the oldest edit stays.
    const restarted = engine();
    await expect(restarted.capture(repo, { include: ["notes"] })).rejects.toThrow(/write guards/);
    await restarted.noteFlush(repo, { upTo: 0, allDocuments: true });
    put(repo, "notes/a.md", "a2");
    await expect(restarted.capture(repo, { include: ["notes"] })).rejects.toThrow(/write guards/);
    status = await restarted.status(repo);
    expect(status.oldestUnprotectedEdit).toBe(oldest);
    expect(status.recoveredFromDamagedRecord).toBe(true);
    expect(status.latestSnapshot).toBeNull();
  });
});
