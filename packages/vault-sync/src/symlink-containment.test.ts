import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createBackupEngine } from "./index.ts";
import { compileScope, listScope } from "./scope.ts";
import { readStable } from "./stable-read.ts";
import { git, isolatedGitEnv, sandbox, type Sandbox } from "./test-fixtures.ts";

const SECRET = "outside bytes that must never be captured\n";
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "vault-sync-link-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setup(): Sandbox {
  const sb = sandbox();
  cleanups.push(sb.cleanup);
  return sb;
}

function put(root: string, path: string, content: string): void {
  const abs = join(root, ...path.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** A folder outside the worktree holding drafts/secret.md. */
function outsideFolder(): string {
  const dir = tempDir();
  put(dir, "drafts/secret.md", SECRET);
  put(dir, "secret.md", SECRET);
  return dir;
}

/** path -> { mode, content } of a commit's tree. */
function tree(repo: string, commit: string): Map<string, { mode: string; content: string }> {
  const out = new Map<string, { mode: string; content: string }>();
  for (const record of git(repo, ["ls-tree", "-r", "-z", commit]).toString("utf8").split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    const [mode, , oid] = record.slice(0, tab).split(" ");
    out.set(record.slice(tab + 1), { mode: mode!, content: git(repo, ["cat-file", "blob", oid!]).toString("utf8") });
  }
  return out;
}

const engine = () => createBackupEngine({ machineId: "test-machine", settleMs: 0, gitEnv: isolatedGitEnv });

function expectNoOutsideBytes(entries: Map<string, { mode: string; content: string }>): void {
  for (const [, entry] of entries) expect(entry.content).not.toBe(SECRET);
}

describe("scope listing never passes through a symlinked directory", () => {
  test("a literal base whose intermediate component is a symlink is skipped and reported", async () => {
    const root = tempDir();
    const outside = outsideFolder();
    put(root, "inside/a.md", "inside\n");
    symlinkSync(outside, join(root, "notes"));
    const listing = await listScope(root, compileScope({ include: ["notes/drafts/**", "notes/drafts/secret.md", "inside/**"] }));
    expect(listing.files).toEqual(["inside/a.md"]);
    expect(listing.skipped).toEqual([
      { path: "notes/drafts", reason: "beyond-symlink" },
      { path: "notes/drafts/secret.md", reason: "beyond-symlink" },
    ]);
  });

  test("a symlinked directory met during a ** walk is listed as a link and not descended", async () => {
    const root = tempDir();
    const outside = outsideFolder();
    put(root, "notes/a.md", "inside\n");
    symlinkSync(outside, join(root, "notes", "linked"));
    const listing = await listScope(root, compileScope({ include: ["**"] }));
    expect(listing.files).toEqual(["notes/a.md", "notes/linked"]);
    expect(listing.files.some((f) => f.startsWith("notes/linked/"))).toBe(false);
  });
});

describe("stable reads stay inside the worktree", () => {
  test("a path whose directory is a symlink is refused before any read", async () => {
    const root = tempDir();
    const outside = outsideFolder();
    symlinkSync(join(outside, "drafts"), join(root, "drafts"));
    const read = await readStable(join(root, "drafts", "secret.md"), { settleMs: 0, retries: 0, maxFileBytes: 1 << 20, root });
    expect(read).toEqual({ ok: false, reason: "beyond-symlink" });
  });

  test("a directory swapped for a symlink after the containment check never yields outside bytes", async () => {
    const root = tempDir();
    const outside = outsideFolder();
    put(root, "drafts/secret.md", "inside version\n");
    let swapped = false;
    const swap = () => {
      if (swapped) return;
      swapped = true;
      renameSync(join(root, "drafts"), join(root, "drafts-moved"));
      symlinkSync(join(outside, "drafts"), join(root, "drafts"));
    };
    const read = await readStable(join(root, "drafts", "secret.md"), { settleMs: 0, retries: 0, maxFileBytes: 1 << 20, root, afterContainmentCheck: swap });
    expect(swapped).toBe(true);
    expect(read).toEqual({ ok: false, reason: "beyond-symlink" });
  });
});

describe("capture never stores bytes from beyond a symlink", () => {
  test("an include through a symlinked directory captures nothing outside and surfaces the reason", async () => {
    const { repo } = setup();
    const outside = outsideFolder();
    put(repo, "inside/a.md", "inside\n");
    symlinkSync(outside, join(repo, "notes"));
    const result = await engine().capture(repo, { include: ["notes/drafts/**", "inside/**"] });
    expect(result.committed).toBe(true);
    expect(result.skipped).toEqual([{ path: "notes/drafts", reason: "beyond-symlink" }]);
    const entries = tree(repo, result.snapshot!);
    expect([...entries.keys()]).toEqual(["inside/a.md"]);
    expectNoOutsideBytes(entries);
  });

  test("a leaf symlink to an outside file is stored as a link holding the target string", async () => {
    const { repo } = setup();
    const outside = outsideFolder();
    const target = join(outside, "secret.md");
    put(repo, "notes/a.md", "inside\n");
    symlinkSync(target, join(repo, "notes", "link.md"));
    symlinkSync(join(outside, "drafts"), join(repo, "notes", "linked-dir"));
    const result = await engine().capture(repo, { include: ["notes/**"] });
    const entries = tree(repo, result.snapshot!);
    expect(entries.get("notes/link.md")).toEqual({ mode: "120000", content: target });
    expect(entries.get("notes/linked-dir")).toEqual({ mode: "120000", content: join(outside, "drafts") });
    expect([...entries.keys()].sort()).toEqual(["notes/a.md", "notes/link.md", "notes/linked-dir"]);
    expectNoOutsideBytes(entries);
    expect(readFileSync(target, "utf8")).toBe(SECRET);
  });

  test("a captured folder later replaced by a symlink is removed from the next snapshot, not kept or followed", async () => {
    const { repo } = setup();
    const outside = outsideFolder();
    put(repo, "notes/drafts/secret.md", "inside version\n");
    const eng = engine();
    const first = await eng.capture(repo, { include: ["notes/drafts/secret.md"] });
    expect(tree(repo, first.snapshot!).get("notes/drafts/secret.md")?.content).toBe("inside version\n");
    renameSync(join(repo, "notes"), join(repo, "notes-moved"));
    symlinkSync(outside, join(repo, "notes"));
    const second = await eng.capture(repo, { include: ["notes/drafts/secret.md"] });
    expect(second.removed).toEqual(["notes/drafts/secret.md"]);
    expect(second.skipped).toEqual([{ path: "notes/drafts/secret.md", reason: "beyond-symlink" }]);
    const entries = tree(repo, second.snapshot!);
    expect(entries.has("notes/drafts/secret.md")).toBe(false);
    expectNoOutsideBytes(entries);
  });
});
