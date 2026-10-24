import { setDefaultTimeout, afterEach, describe, expect, test } from "bun:test";
setDefaultTimeout(30_000);
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { createBackupEngine, type BackupEngineOptions } from "./index.ts";
import { autoEnabled, git, gitText, isolatedGitEnv, permissiveGuards, sandbox, tick, type Sandbox } from "./test-fixtures.ts";

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
  return autoEnabled(createBackupEngine({ machineId: "test-machine", settleMs: 5, gitEnv: isolatedGitEnv, ...permissiveGuards, ...overrides }));
}

function put(root: string, path: string, content: string | Buffer): void {
  const abs = join(root, ...path.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function blobAt(repo: string, snapshot: string, path: string): string {
  return gitText(repo, ["cat-file", "-p", `${snapshot}:${path}`]);
}

async function backUp(e: ReturnType<typeof engine>, repo: string, scope = { include: ["notes"] }) {
  const captured = await e.capture(repo, scope);
  const pushed = await e.pushBackup(repo);
  const verified = await e.verify(repo);
  return { captured, pushed, verified };
}

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const posix = process.platform !== "win32";

describe("reported edits need a save acknowledgement (review finding 5)", () => {
  test("an unflushed edit survives an unchanged capture, push and verify; its acknowledged save is then protected", async () => {
    const { repo } = setup();
    put(repo, "notes/a.md", "saved old\n");
    let clock = Date.UTC(2026, 4, 1, 9, 0, 0);
    const e = engine({ now: () => clock });
    expect((await backUp(e, repo)).verified.verified).toBe(true);
    clock += 1000;
    const edited = clock;
    const ticket = await e.noteEdit(repo, edited, { path: "notes/a.md" });
    clock += 60_000;
    const unchanged = await backUp(e, repo);
    expect(unchanged.captured.committed).toBe(false);
    expect(unchanged.verified.verified).toBe(true);
    let status = await e.status(repo);
    expect(status.oldestUnprotectedEdit).toBe(edited);
    expect(status.unflushedEditSince).toBe(edited);
    expect(status.protectionAgeSeconds).toBe(60);

    put(repo, "notes/a.md", "saved new\n");
    await e.noteFlush(repo, { upTo: ticket, paths: ["notes/a.md"] });
    clock += 1000;
    const saved = await backUp(e, repo);
    expect(blobAt(repo, saved.captured.snapshot!, "notes/a.md")).toBe("saved new");
    status = await e.status(repo);
    expect(status.oldestUnprotectedEdit).toBeNull();
    expect(status.unflushedEditSince).toBeNull();
    expect(status.protectedThrough).toBe(saved.captured.startedAt);
  });
});

describe("pending files keep the earlier floor (review finding 4)", () => {
  test("an acknowledged edit whose file the capture cannot read stays as old as it is, or older", async () => {
    const { repo } = setup();
    put(repo, "notes/a.md", "short\n");
    let clock = 1_000_000;
    const e = engine({ now: () => clock, maxFileBytes: 10 });
    expect((await backUp(e, repo)).verified.verified).toBe(true);
    clock = 1_001_000;
    const ticket = await e.noteEdit(repo, clock, { path: "notes/a.md" });
    put(repo, "notes/a.md", "now longer than the limit\n");
    await e.noteFlush(repo, { upTo: ticket, paths: ["notes/a.md"] });
    clock = 1_601_000;
    const later = await backUp(e, repo);
    expect(later.captured.pending).toEqual([{ path: "notes/a.md", reason: "too-large" }]);
    const status = await e.status(repo);
    // The file was last read by the capture at 1,000,000; any change since then is unprotected.
    expect(status.oldestUnprotectedEdit).toBe(1_000_000);
    expect(status.protectionAgeSeconds).toBe(601);
    expect(status.protectedThrough).toBe(1_000_000);
    expect(gitText(repo, ["cat-file", "-p", `${later.captured.snapshot}:notes/a.md`])).toBe("short");
  });
});

describe("writer contract (review finding 6)", () => {
  const OLD = "complete old text\n";
  const NEW = "complete new text, longer than before\n";

  test("an atomic writer paused mid-write is never captured torn", async () => {
    const { repo } = setup();
    put(repo, "notes/doc.md", OLD);
    const e = engine({ settleMs: 250 });
    const scope = { include: ["notes"], exclude: ["notes/*.tmp"] };
    await e.capture(repo, scope);
    // Write part of the new version into a temporary file, then pause longer than the settle time.
    const temp = join(repo, "notes", ".doc.md.tmp");
    writeFileSync(temp, "partial");
    await tick(300);
    const paused = await e.capture(repo, scope);
    expect(blobAt(repo, paused.snapshot!, "notes/doc.md")).toBe(OLD.trim());
    writeFileSync(temp, NEW);
    renameSync(temp, join(repo, "notes", "doc.md"));
    await tick(300);
    const done = await e.capture(repo, scope);
    expect(blobAt(repo, done.snapshot!, "notes/doc.md")).toBe(NEW.trim());
  });

  test("a coordinated in-place writer paused mid-write is left pending and stays unprotected until its save", async () => {
    const { repo } = setup();
    put(repo, "notes/doc.md", OLD);
    let clock = Date.UTC(2026, 4, 1, 9, 0, 0);
    const e = engine({ settleMs: 250, now: () => clock });
    expect((await backUp(e, repo)).verified.verified).toBe(true);
    clock += 1000;
    const started = clock;
    const writeToken = await e.noteWriteStart(repo, ["notes/doc.md"]);
    const fd = openSync(join(repo, "notes", "doc.md"), "r+");
    writeSync(fd, "partial", 0);
    await tick(300);
    clock += 1000;
    const paused = await backUp(e, repo);
    expect(paused.captured.pending).toEqual([{ path: "notes/doc.md", reason: "writing" }]);
    expect(blobAt(repo, paused.captured.snapshot!, "notes/doc.md")).toBe(OLD.trim());
    let status = await e.status(repo);
    expect(status.writing).toEqual(["notes/doc.md"]);
    // A file left pending is unprotected from the last capture that read it, which is before the write began.
    expect(status.oldestUnprotectedEdit).toBe(started - 1000);

    writeSync(fd, NEW, 0);
    fsyncSync(fd);
    closeSync(fd);
    await e.noteFlush(repo, { upTo: 0, paths: ["notes/doc.md"], completedWrites: [{ path: "notes/doc.md", token: writeToken }] });
    await tick(300);
    clock += 1000;
    const finished = await backUp(e, repo);
    expect(blobAt(repo, finished.captured.snapshot!, "notes/doc.md")).toBe(NEW.trim());
    status = await e.status(repo);
    expect(status.writing).toEqual([]);
    expect(status.oldestUnprotectedEdit).toBeNull();
  });

  test("a write reported while a capture is reading is not taken from that capture, and the report does not wait for it", async () => {
    const { repo } = setup();
    put(repo, "notes/doc.md", OLD);
    const e = engine({ settleMs: 400, stableReadRetries: 6 });
    await e.capture(repo, { include: ["notes"] });
    put(repo, "notes/doc.md", "second complete version\n");
    // The capture now waits for the fresh file to settle while holding the operation lock.
    const running = e.capture(repo, { include: ["notes"] });
    await tick(100);
    const reported = Date.now();
    await e.noteWriteStart(repo, ["notes/doc.md"]);
    expect(Date.now() - reported).toBeLessThan(300);
    writeFileSync(join(repo, "notes", "doc.md"), "partial");
    const result = await running;
    expect(result.pending).toEqual([{ path: "notes/doc.md", reason: "writing" }]);
    expect(blobAt(repo, result.snapshot!, "notes/doc.md")).toBe(OLD.trim());
  });
});

describe("an unreadable folder is not a deletion (review finding 8)", () => {
  test.if(posix && !isRoot)("files in a folder that cannot be listed keep their previous version and deadline", async () => {
    const { repo } = setup();
    put(repo, "notes/a.md", "a\n");
    put(repo, "notes/sub/b.md", "b\n");
    let clock = Date.UTC(2026, 4, 1, 9, 0, 0);
    const e = engine({ now: () => clock });
    const first = await backUp(e, repo);
    expect(first.verified.verified).toBe(true);
    const sub = join(repo, "notes", "sub");
    const notes = join(repo, "notes");
    try {
      chmodSync(sub, 0o000);
      clock += 60_000;
      const partial = await e.capture(repo, { include: ["notes"] });
      expect(partial.removed).toEqual([]);
      expect(partial.pending).toEqual([{ path: "notes/sub/b.md", reason: "unreadable" }, { path: "notes/sub", reason: "unlisted" }]);
      expect(partial.committed).toBe(false);
      // Unprotected since the engine last looked.
      expect((await e.status(repo)).oldestUnprotectedEdit).toBe(first.captured.startedAt);
      expect((await e.status(repo)).unlistedFolders).toEqual(["notes/sub"]);

      // A literal include whose parent cannot be read is also kept, not removed.
      chmodSync(sub, 0o755);
      chmodSync(notes, 0o000);
      clock += 60_000;
      const literal = await e.capture(repo, { include: ["notes/a.md", "notes/sub"] });
      expect(literal.removed).toEqual([]);
      expect(literal.pending.filter((p) => p.reason === "unreadable").map((p) => p.path).sort()).toEqual(["notes/a.md", "notes/sub/b.md"]);
      expect(literal.pending.filter((p) => p.reason === "unlisted").map((p) => p.path).sort()).toEqual(["notes/a.md", "notes/sub"]);
    } finally {
      chmodSync(notes, 0o755);
      chmodSync(sub, 0o755);
    }
    clock += 60_000;
    const readable = await backUp(e, repo, { include: ["notes"] });
    expect(readable.captured.removed).toEqual([]);
    expect(readable.verified.verified).toBe(true);
    expect((await e.status(repo)).oldestUnprotectedEdit).toBeNull();
    expect((await e.status(repo)).unlistedFolders).toEqual([]);
  });

  test("a folder that really was deleted is still recorded as removed", async () => {
    const { repo } = setup();
    put(repo, "notes/sub/b.md", "b\n");
    put(repo, "notes/a.md", "a\n");
    const e = engine();
    await e.capture(repo, { include: ["notes"] });
    renameSync(join(repo, "notes", "sub"), join(repo, "moved-out"));
    const after = await e.capture(repo, { include: ["notes"] });
    expect(after.removed).toEqual(["notes/sub/b.md"]);
  });
});

describe("restore reports recorded coverage, not commit time (review finding 5)", () => {
  test("a backup's coverage comes from its snapshot record; a tip without one is unknown", async () => {
    const { repo, remote } = setup();
    put(repo, "notes/a.md", "a\n");
    put(repo, "notes/big.md", "far too long for the limit\n");
    let clock = Date.UTC(2026, 4, 1, 9, 0, 0);
    const e = engine({ now: () => clock, maxFileBytes: 10 });
    const first = await e.capture(repo, { include: ["notes"] });
    expect(first.pending).toEqual([{ path: "notes/big.md", reason: "too-large" }]);
    clock += 120_000;
    put(repo, "notes/a.md", "a changed\n");
    const second = await backUp(e, repo);
    expect(second.verified.verified).toBe(true);

    const [entry] = await e.listBackups(repo);
    expect(entry!.tip).toBe(second.captured.snapshot!);
    expect(entry!.snapshotTime).toBe(Math.floor(second.captured.startedAt / 1000) * 1000);
    expect(entry!.coverage).toBe("recorded");
    expect(entry!.protectedThrough).toBe(first.startedAt);
    expect(entry!.pendingFiles).toBe(1);

    // Someone else's commit at the tip of a backup branch carries no coverage record.
    const foreign = gitText(repo, ["commit-tree", `${second.captured.snapshot}^{tree}`, "-p", second.captured.snapshot!, "-m", "not a snapshot"]);
    git(repo, ["push", "-q", remote, `${foreign}:refs/heads/backup/other-machine/0123456789ab/2026-05-01`]);
    const other = (await e.listBackups(repo)).find((b) => b.machine === "other-machine")!;
    expect(other.coverage).toBe("unknown");
    expect(other.protectedThrough).toBeNull();
    expect(other.pendingFiles).toBeNull();
  });
});
