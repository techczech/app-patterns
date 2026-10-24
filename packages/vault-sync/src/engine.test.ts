import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createBackupEngine, type BackupEngineOptions } from "./index.ts";
import { autoEnabled, git, gitAsync, gitText, isolatedGitEnv, permissiveGuards, sandbox, tick, type Sandbox } from "./test-fixtures.ts";

const ENGINE_EMAIL = "backup@vault-sync.invalid";
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

function commitAll(repo: string, message: string): void {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", message]);
}

/** Every regular file under root except .git, as relative path -> bytes (hex for exact comparison). */
function worktreeFiles(root: string, rel = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(out, worktreeFiles(root, child));
    else out[child] = readFileSync(join(root, child)).toString("hex");
  }
  return out;
}

/** path -> blob content of a commit's tree, read with NUL-safe output. */
function treeOf(gitDirOrRepo: string, commit: string, bare = false): Map<string, string> {
  const args = bare ? ["--git-dir", gitDirOrRepo] : [];
  const cwd = bare ? dirname(gitDirOrRepo) : gitDirOrRepo;
  const files = new Map<string, string>();
  const records = git(cwd, [...args, "ls-tree", "-r", "-z", commit]).toString("utf8").split("\0").filter(Boolean);
  for (const record of records) {
    const tab = record.indexOf("\t");
    const oid = record.slice(0, tab).split(" ")[2]!;
    files.set(record.slice(tab + 1), git(cwd, [...args, "cat-file", "blob", oid]).toString("utf8"));
  }
  return files;
}

/** Snapshot commits on a backup branch, newest first (user commits reachable through HEAD parents are skipped). */
function snapshots(repo: string, ref: string): string[] {
  return gitText(repo, ["log", "--format=%H %ae", ref]).split("\n").filter((l) => l.endsWith(ENGINE_EMAIL)).map((l) => l.split(" ")[0]!);
}

describe("capture never touches the user's Git state", () => {
  test("100 captures with edits leave index bytes, HEAD, staged changes and worktree files identical", async () => {
    const { repo } = setup();
    put(repo, "notes/a.md", "alpha\n");
    put(repo, "notes/b.md", "beta\n");
    commitAll(repo, "start");
    put(repo, "notes/a.md", "alpha staged\n");
    git(repo, ["add", "notes/a.md"]);
    put(repo, "notes/a.md", "alpha in worktree after staging\n");
    put(repo, "notes/staged-new.md", "new and staged\n");
    git(repo, ["add", "notes/staged-new.md"]);
    put(repo, "scratch.txt", "untracked, outside scope\n");

    const indexBefore = readFileSync(join(repo, ".git/index"));
    const headFileBefore = readFileSync(join(repo, ".git/HEAD"));
    const headBefore = gitText(repo, ["rev-parse", "HEAD"]);
    const stagedBefore = git(repo, ["diff", "--cached", "--binary"]);
    const e = engine();
    const scope = { include: ["notes"] };
    let committed = 0;
    for (let i = 0; i < 100; i += 1) {
      put(repo, "notes/b.md", `beta revision ${i}\n`);
      if (i % 10 === 0) put(repo, `notes/added ${i}.md`, `added at ${i}\n`);
      if (i % 10 === 5) rmSync(join(repo, `notes/added ${i - 5}.md`));
      const result = await e.capture(repo, scope);
      if (result.committed) committed += 1;
    }
    const worktreeAfterCaptures = worktreeFiles(repo);

    expect(readFileSync(join(repo, ".git/index")).equals(indexBefore)).toBe(true);
    expect(readFileSync(join(repo, ".git/HEAD")).equals(headFileBefore)).toBe(true);
    expect(gitText(repo, ["rev-parse", "HEAD"])).toBe(headBefore);
    expect(git(repo, ["diff", "--cached", "--binary"]).equals(stagedBefore)).toBe(true);
    expect(committed).toBe(100);

    // The worktree holds exactly what the test wrote; the engine wrote nothing.
    const expected: Record<string, string> = {
      "notes/a.md": Buffer.from("alpha in worktree after staging\n").toString("hex"),
      "notes/b.md": Buffer.from("beta revision 99\n").toString("hex"),
      "notes/staged-new.md": Buffer.from("new and staged\n").toString("hex"),
      "scratch.txt": Buffer.from("untracked, outside scope\n").toString("hex"),
    };
    expect(worktreeAfterCaptures).toEqual(expected);

    // The snapshot holds worktree bytes, not staged bytes, and only scoped paths.
    const status = await e.status(repo);
    const tree = treeOf(repo, status.latestSnapshot!);
    expect(tree.get("notes/a.md")).toBe("alpha in worktree after staging\n");
    expect(tree.get("notes/b.md")).toBe("beta revision 99\n");
    expect(tree.has("scratch.txt")).toBe(false);
    expect([...tree.keys()].sort()).toEqual(["notes/a.md", "notes/b.md", "notes/staged-new.md"]);
    expect(gitText(repo, ["for-each-ref", "--format=%(refname)", "refs/heads/backup/"]).split("\n")).toHaveLength(1);
  }, 120_000);

  test("a concurrent commit loop never meets index.lock and its staged content never enters a snapshot", async () => {
    const { dir, repo } = setup();
    put(repo, "staged.txt", "initial\n");
    put(repo, "notes/other.md", "other\n");
    commitAll(repo, "start");
    put(repo, "staged.txt", "WORKTREE VERSION\n");

    const e = engine();
    let done = false;
    const commits: { code: number; stderr: string }[] = [];
    const stagedOids: string[] = [];
    const committer = (async () => {
      for (let i = 0; i < 40; i += 1) {
        const source = join(dir, `staged-${i}.txt`);
        writeFileSync(source, `STAGED ONLY ${i}\n`);
        const oid = gitText(repo, ["hash-object", "-w", source]);
        stagedOids.push(oid);
        commits.push(await gitAsync(repo, ["update-index", "--cacheinfo", `100644,${oid},staged.txt`]));
        commits.push(await gitAsync(repo, ["commit", "-q", "-m", `user commit ${i}`]));
      }
      done = true;
    })();
    let captures = 0;
    while (!done) {
      put(repo, "notes/other.md", `other ${captures}\n`);
      await e.capture(repo, { include: ["staged.txt", "notes"] });
      captures += 1;
    }
    await committer;

    expect(commits.filter((c) => c.code !== 0)).toEqual([]);
    expect(commits.some((c) => c.stderr.includes("index.lock"))).toBe(false);
    expect(captures).toBeGreaterThan(3);
    // The user's history holds exactly the staged versions, in order.
    const userHistory = gitText(repo, ["log", "--format=%H", "-n", "40", "main"]).split("\n").reverse();
    expect(userHistory.map((c) => gitText(repo, ["rev-parse", `${c}:staged.txt`]))).toEqual(stagedOids);
    expect(gitText(repo, ["ls-files", "-s", "staged.txt"]).split(" ")[1]).toBe(stagedOids[39]!);
    // Every snapshot holds the worktree version.
    const ref = (await e.status(repo)).latestRef!;
    const snaps = snapshots(repo, ref);
    expect(snaps.length).toBe(captures);
    for (const snap of snaps) expect(git(repo, ["show", `${snap}:staged.txt`]).toString()).toBe("WORKTREE VERSION\n");
  }, 120_000);
});

describe("stable reads", () => {
  const OLD = `old version\n${"o".repeat(4000)}\n`;
  const version = (k: number) => `new version ${k}\n${"n".repeat(4000 + k)}\n`;

  test("a capture that starts while a file is truncated gets the new full content or leaves it pending", async () => {
    const { repo } = setup();
    put(repo, "doc.md", OLD);
    const e = engine({ settleMs: 100 });
    await e.capture(repo, { include: ["doc.md"] });
    writeFileSync(join(repo, "doc.md"), "");
    const running = e.capture(repo, { include: ["doc.md"] });
    await tick(40);
    writeFileSync(join(repo, "doc.md"), version(1));
    const result = await running;
    const content = treeOf(repo, result.snapshot!).get("doc.md");
    if (result.pending.length) expect(content).toBe(OLD);
    else expect(content).toBe(version(1));
  }, 30_000);

  test("files rewritten as truncate-then-write during captures are never captured torn", async () => {
    const { repo } = setup();
    put(repo, "doc.md", OLD);
    const e = engine({ settleMs: 100 });
    const valid = new Set([OLD]);
    let done = false;
    const writer = (async () => {
      for (let k = 0; k < 15; k += 1) {
        writeFileSync(join(repo, "doc.md"), "");
        await tick(30);
        valid.add(version(k));
        writeFileSync(join(repo, "doc.md"), version(k));
        await tick(Math.floor(Math.random() * 250));
      }
      done = true;
    })();
    let pending = 0;
    let captured = 0;
    while (!done) {
      const result = await e.capture(repo, { include: ["doc.md"] });
      if (result.pending.length) pending += 1;
      else captured += 1;
    }
    await writer;
    const ref = (await e.status(repo)).latestRef!;
    const snaps = snapshots(repo, ref);
    expect(captured + pending).toBeGreaterThan(3);
    for (const snap of snaps) expect(valid.has(treeOf(repo, snap).get("doc.md")!)).toBe(true);
  }, 60_000);
});

describe("deadline record", () => {
  test("survives restart, is not reset by a failed push, and moves only after push and verify", async () => {
    const { repo, remote } = setup();
    put(repo, "notes/a.md", "a\n");
    let clock = Date.UTC(2026, 0, 10, 12, 0, 0);
    const now = () => clock;
    let first: ReturnType<typeof engine> | null = engine({ now });
    await first.noteEdit(repo, clock - 30_000);
    first = null;

    const second = engine({ now });
    let status = await second.status(repo);
    expect(status.oldestUnprotectedEdit).toBe(clock - 30_000);
    expect(status.protectionAgeSeconds).toBe(30);

    // The remote becomes unreachable without its configured address changing (which would void enablement).
    renameSync(remote, `${remote}.away`);
    clock += 10_000;
    const captured = await second.capture(repo, { include: ["notes"] });
    expect(captured.committed).toBe(true);
    const failed = await second.pushBackup(repo);
    expect(failed.state).toBe("failed");
    expect((await second.verify(repo)).verified).toBe(false);
    status = await second.status(repo);
    expect(status.oldestUnprotectedEdit).toBe(clock - 40_000);
    expect(status.lastError?.kind).toBe("push-failed");
    expect(status.lastVerifiedSnapshot).toBeNull();

    // A third instance still sees the same deadline.
    const third = engine({ now });
    expect((await third.status(repo)).oldestUnprotectedEdit).toBe(Date.UTC(2026, 0, 10, 11, 59, 30));

    renameSync(`${remote}.away`, remote);
    clock += 60_000;
    const pushed = await third.pushBackup(repo);
    expect(pushed.state).toBe("pushed");
    // Push success alone is not verification.
    expect((await third.status(repo)).oldestUnprotectedEdit).toBe(Date.UTC(2026, 0, 10, 11, 59, 30));
    const verified = await third.verify(repo);
    expect(verified).toEqual({ verified: true, ref: captured.ref!, snapshot: captured.snapshot! });
    status = await third.status(repo);
    expect(status.oldestUnprotectedEdit).toBeNull();
    expect(status.protectionAgeSeconds).toBe(0);
    expect(status.lastVerifiedSnapshot).toBe(captured.snapshot);
    expect(status.protectedThrough).toBe(captured.startedAt);
    expect(status.lastError).toBeNull();
    expect(gitText(repo, ["ls-remote", "origin", captured.ref!]).split("\t")[0]).toBe(captured.snapshot!);
  }, 30_000);

  test("an edit noted after capture started stays unprotected after that snapshot verifies", async () => {
    const { repo } = setup();
    put(repo, "notes/a.md", "a\n");
    let clock = Date.UTC(2026, 0, 10, 12, 0, 0);
    const e = engine({ now: () => clock });
    const captured = await e.capture(repo, { include: ["notes"] });
    clock += 5_000;
    await e.noteEdit(repo, clock);
    expect((await e.pushBackup(repo)).state).toBe("pushed");
    expect((await e.verify(repo)).verified).toBe(true);
    clock += 20_000;
    const status = await e.status(repo);
    expect(status.oldestUnprotectedEdit).toBe(captured.startedAt);
    expect(status.protectionAgeSeconds).toBe(25);
  }, 30_000);

  test("a damaged record is kept aside and treated as unprotected, never as protected", async () => {
    const { repo } = setup();
    put(repo, "notes/a.md", "a\n");
    const e = engine();
    await e.noteEdit(repo, Date.now() - 1000);
    writeFileSync(join(repo, ".git/vault-sync/deadline.json"), "{ not json");
    const status = await engine().status(repo);
    expect(status.recoveredFromDamagedRecord).toBe(true);
    expect(status.oldestUnprotectedEdit).not.toBeNull();
    expect(readdirSync(join(repo, ".git/vault-sync")).some((n) => n.startsWith("deadline.json.damaged-"))).toBe(true);
  });
});

describe("backup branches", () => {
  test("day rollover continues the chain from the previous day's last snapshot", async () => {
    const { repo } = setup();
    put(repo, "notes/a.md", "a0\n");
    commitAll(repo, "start");
    let clock = Date.UTC(2026, 2, 1, 23, 59, 0);
    const e = engine({ now: () => clock });
    const s1 = await e.capture(repo, { include: ["notes"] });
    put(repo, "notes/a.md", "a1\n");
    clock += 30_000;
    const s2 = await e.capture(repo, { include: ["notes"] });
    put(repo, "notes/a.md", "a2\n");
    clock = Date.UTC(2026, 2, 2, 0, 0, 30);
    const s3 = await e.capture(repo, { include: ["notes"] });

    const { checkoutId } = await e.status(repo);
    expect(s1.ref).toBe(`refs/heads/backup/test-machine/${checkoutId}/2026-03-01`);
    expect(s2.ref).toBe(s1.ref);
    expect(s3.ref).toBe(`refs/heads/backup/test-machine/${checkoutId}/2026-03-02`);
    expect(gitText(repo, ["rev-parse", `${s2.snapshot}^1`])).toBe(s1.snapshot!);
    expect(gitText(repo, ["rev-parse", `${s3.snapshot}^1`])).toBe(s2.snapshot!);
    expect(gitText(repo, ["rev-parse", s1.ref!])).toBe(s2.snapshot!);
    // HEAD was the second parent of the first snapshot only... and of none after, since it is already an ancestor.
    expect(gitText(repo, ["rev-list", "--parents", "-n", "1", s3.snapshot!]).split(" ")).toHaveLength(2);
    expect((await e.pushBackup(repo)).state).toBe("pushed");
    expect((await e.verify(repo)).verified).toBe(true);

    // Nothing changed on the next day: no commit and no new branch.
    clock = Date.UTC(2026, 2, 3, 9, 0, 0);
    const s4 = await e.capture(repo, { include: ["notes"] });
    expect(s4.committed).toBe(false);
    expect(s4.snapshot).toBe(s3.snapshot);
    expect(gitText(repo, ["for-each-ref", "--format=%(refname)", "refs/heads/backup/"]).split("\n")).toHaveLength(2);
  }, 30_000);

  test("a user commit made after the last snapshot becomes the next snapshot's second parent", async () => {
    const { repo } = setup();
    put(repo, "notes/a.md", "a0\n");
    commitAll(repo, "start");
    const e = engine();
    const s1 = await e.capture(repo, { include: ["notes"] });
    put(repo, "notes/a.md", "a1\n");
    commitAll(repo, "user edit");
    const head = gitText(repo, ["rev-parse", "HEAD"]);
    put(repo, "notes/a.md", "a2\n");
    const s2 = await e.capture(repo, { include: ["notes"] });
    expect(gitText(repo, ["rev-list", "--parents", "-n", "1", s2.snapshot!]).split(" ").slice(1)).toEqual([s1.snapshot!, head]);
  }, 30_000);

  test("paths with spaces, Unicode, tabs and newlines round-trip through capture and push", async () => {
    const { repo, remote } = setup();
    const names = ["with space.md", "café ünï.md", "tab\there.md", "new\nline.md", "dir with space/ü/nested file.md", "日本語.md", "emoji 🙂.md"];
    for (const name of names) put(repo, name, `content of ${JSON.stringify(name)}\n`);
    const e = engine();
    const first = await e.capture(repo, { include: ["**"] });
    expect(first.added.sort()).toEqual([...names].sort());
    const tree = treeOf(repo, first.snapshot!);
    expect([...tree.keys()].sort()).toEqual([...names].sort());
    for (const name of names) expect(tree.get(name)).toBe(`content of ${JSON.stringify(name)}\n`);

    expect((await e.pushBackup(repo)).state).toBe("pushed");
    expect((await e.verify(repo)).verified).toBe(true);
    const remoteTree = treeOf(remote, first.ref!, true);
    expect([...remoteTree.entries()].sort()).toEqual([...tree.entries()].sort());

    rmSync(join(repo, "tab\there.md"));
    put(repo, "new\nline.md", "changed\n");
    const second = await e.capture(repo, { include: ["**"] });
    expect(second.removed).toEqual(["tab\there.md"]);
    expect(second.modified).toEqual(["new\nline.md"]);
    // A literal include naming one awkward path selects only it.
    const only = await engine().capture(repo, { include: ["new\nline.md"] });
    expect([...treeOf(repo, only.snapshot!).keys()]).toEqual(["new\nline.md"]);
  }, 30_000);

  test("excluded paths and .git are never captured; an unchanged tree makes no commit", async () => {
    const { repo } = setup();
    put(repo, "notes/a.md", "a\n");
    put(repo, "notes/drafts/private.md", "draft\n");
    put(repo, "notes/cache.tmp", "tmp\n");
    put(repo, "notes/inner/.git/config", "not a repo of ours\n");
    put(repo, "notes/inner/file.md", "nested repo file\n");
    const e = engine();
    const scope = { include: ["notes/**"], exclude: ["notes/drafts", "**/*.tmp"] };
    const first = await e.capture(repo, scope);
    expect([...treeOf(repo, first.snapshot!).keys()]).toEqual(["notes/a.md"]);
    const again = await e.capture(repo, scope);
    expect(again.committed).toBe(false);
    expect(again.snapshot).toBe(first.snapshot);
  });

  test("a rejected push is reported and never forced", async () => {
    const { dir, repo, remote } = setup();
    put(repo, "notes/a.md", "a\n");
    const e = engine();
    const s1 = await e.capture(repo, { include: ["notes"] });
    expect((await e.pushBackup(repo)).state).toBe("pushed");
    expect((await e.verify(repo)).verified).toBe(true);

    // Someone else moves the backup branch on the remote.
    const other = join(dir, "other");
    git(dir, ["clone", "-q", remote, other]);
    git(other, ["fetch", "-q", "origin", s1.ref!]);
    const foreign = gitText(other, ["commit-tree", `${s1.snapshot}^{tree}`, "-p", s1.snapshot!, "-m", "someone else"]);
    git(other, ["push", "-q", "origin", `${foreign}:${s1.ref}`]);

    put(repo, "notes/a.md", "a changed\n");
    const s2 = await e.capture(repo, { include: ["notes"] });
    const pushed = await e.pushBackup(repo);
    expect(pushed.state).toBe("rejected");
    expect(gitText(repo, ["ls-remote", "origin", s1.ref!]).split("\t")[0]).toBe(foreign);
    const status = await e.status(repo);
    expect(status.lastError?.kind).toBe("push-rejected");
    expect(status.oldestUnprotectedEdit).toBe(s2.startedAt);
    const verified = await e.verify(repo);
    expect(verified.verified).toBe(false);
    if (!verified.verified) expect(verified.state).toBe("mismatch");
  }, 30_000);

  test("repository hooks are not run and are listed in status", async () => {
    const { dir, repo } = setup();
    put(repo, "notes/a.md", "a\n");
    commitAll(repo, "start");
    for (const hook of ["pre-push", "reference-transaction", "post-index-change", "pre-commit"]) {
      const file = join(repo, ".git/hooks", hook);
      writeFileSync(file, `#!/bin/sh\necho ran > "${join(dir, `hook-${hook}`)}"\n`);
      chmodSync(file, 0o755);
    }
    const e = engine();
    put(repo, "notes/a.md", "b\n");
    await e.capture(repo, { include: ["notes"] });
    expect((await e.pushBackup(repo)).state).toBe("pushed");
    expect((await e.verify(repo)).verified).toBe(true);
    for (const hook of ["pre-push", "reference-transaction", "post-index-change", "pre-commit"]) expect(existsSync(join(dir, `hook-${hook}`))).toBe(false);
    expect((await e.status(repo)).repositoryHooksNotRun).toEqual(["post-index-change", "pre-commit", "pre-push", "reference-transaction"]);
  }, 30_000);
});
