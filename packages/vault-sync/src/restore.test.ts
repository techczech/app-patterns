import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, renameSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BackupRefusedError, createBackupEngine, RestoreRefusedError, type BackupEngineOptions } from "./index.ts";
import { isDotGitName, restoreTestHooks } from "./restore.ts";
import { compileScope } from "./scope.ts";
import { autoEnabled, git, gitText, isolatedGitEnv, permissiveGuards, sandbox, type Sandbox } from "./test-fixtures.ts";

const sandboxes: Sandbox[] = [];
afterEach(() => {
  for (const key of Object.keys(restoreTestHooks)) delete (restoreTestHooks as Record<string, unknown>)[key];
  while (sandboxes.length) sandboxes.pop()!.cleanup();
});

function setup(): Sandbox {
  const sb = sandbox();
  sandboxes.push(sb);
  return sb;
}

function engine(machineId: string, overrides: Partial<BackupEngineOptions> = {}) {
  return autoEnabled(createBackupEngine({ machineId, settleMs: 5, gitEnv: isolatedGitEnv, ...permissiveGuards, ...overrides }));
}

function put(root: string, path: string, content: string | Buffer): void {
  const abs = join(root, ...path.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function clone(sb: Sandbox, name: string): string {
  const dest = join(sb.dir, name);
  git(sb.dir, ["clone", "-q", sb.remote, dest]);
  return dest;
}

/** A vault with one committed file, pushed to main on the remote. */
function seeded(): { sb: Sandbox; repo: string } {
  const sb = setup();
  put(sb.repo, "notes/a.md", "alpha\n");
  git(sb.repo, ["add", "-A"]);
  git(sb.repo, ["commit", "-q", "-m", "start"]);
  git(sb.repo, ["push", "-q", "origin", "main"]);
  return { sb, repo: sb.repo };
}

async function backup(e: ReturnType<typeof engine>, repo: string, scope = { include: ["notes"] }) {
  const captured = await e.capture(repo, scope);
  const pushed = await e.pushBackup(repo);
  expect(pushed.state).toBe("pushed");
  return captured.snapshot!;
}

describe("restore round trip", () => {
  test("edit, back up, delete locally, restore from a clone that never backed up", async () => {
    const { sb, repo } = seeded();
    const a = engine("machine-a");
    put(repo, "notes/a.md", "alpha edited and not committed\n");
    put(repo, "notes/deep/b.md", "only in the backup\n");
    const snap = await backup(a, repo);
    rmSync(join(repo, "notes"), { recursive: true });

    const other = clone(sb, "wiped");
    const b = engine("machine-b");
    const backups = await b.listBackups(other);
    expect(backups).toHaveLength(1);
    expect(backups[0]!.machine).toBe("machine-a");
    expect(backups[0]!.tip).toBe(snap);
    const snaps = await b.listSnapshots(other, backups[0]!.branch);
    expect(snaps.map((s) => s.id)).toEqual([snap]);
    expect((await b.readAtSnapshot(other, snap, "notes/deep/b.md")).toString()).toBe("only in the backup\n");

    // Not enabled on this clone: restore still works.
    const result = await b.restoreFile(other, snap, "notes/deep/b.md");
    expect(result).toMatchObject({ state: "restored", path: "notes/deep/b.md", sibling: false });
    expect(readFileSync(join(other, "notes/deep/b.md"), "utf8")).toBe("only in the backup\n");
    // An ordinary uncommitted change.
    expect(gitText(other, ["status", "--porcelain"])).toContain("notes/deep/");
    expect(existsSync(join(other, ".git", "vault-sync"))).toBe(false);
  }, 30_000);

  test("an existing different file gets a sibling copy; explicit target needs overwrite", async () => {
    const { repo } = seeded();
    const e = engine("machine-a");
    put(repo, "notes/a.md", "backed up\n");
    const snap = await backup(e, repo);
    put(repo, "notes/a.md", "newer local text\n");

    const sib = await e.restoreFile(repo, snap, "notes/a.md");
    expect(sib.sibling).toBe(true);
    expect(sib.path).toMatch(/^notes\/a \(restored \d{4}-\d{2}-\d{2} \d{4}\)\.md$/);
    expect(readFileSync(join(repo, sib.path), "utf8")).toBe("backed up\n");
    expect(readFileSync(join(repo, "notes/a.md"), "utf8")).toBe("newer local text\n");

    await expect(e.restoreFile(repo, snap, "notes/a.md", { targetPath: "notes/a.md" })).rejects.toMatchObject({ reason: "target-exists" });
    expect(readFileSync(join(repo, "notes/a.md"), "utf8")).toBe("newer local text\n");
    const over = await e.restoreFile(repo, snap, "notes/a.md", { overwrite: true });
    expect(over).toMatchObject({ state: "restored", sibling: false });
    expect(readFileSync(join(repo, "notes/a.md"), "utf8")).toBe("backed up\n");
    expect(readdirSync(join(repo, "notes")).filter((n) => n.includes(".tmp"))).toEqual([]);
    // Identical bytes: nothing to do.
    expect((await e.restoreFile(repo, snap, "notes/a.md")).state).toBe("unchanged");
  }, 30_000);

  test("restore leaves HEAD and the index byte-identical", async () => {
    const { sb, repo } = seeded();
    const a = engine("machine-a");
    put(repo, "notes/a.md", "to restore\n");
    const snap = await backup(a, repo);
    const other = clone(sb, "second");
    put(other, "notes/staged.md", "staged\n");
    git(other, ["add", "notes/staged.md"]);
    const index = readFileSync(join(other, ".git/index"));
    const headFile = readFileSync(join(other, ".git/HEAD"));
    const head = gitText(other, ["rev-parse", "HEAD"]);
    const branches = gitText(other, ["for-each-ref", "refs/heads", "refs/remotes"]);
    const b = engine("machine-b");
    await b.listBackups(other);
    await b.restoreFile(other, snap, "notes/a.md", { targetPath: "notes/recovered.md" });
    expect(readFileSync(join(other, ".git/index")).equals(index)).toBe(true);
    expect(readFileSync(join(other, ".git/HEAD")).equals(headFile)).toBe(true);
    expect(gitText(other, ["rev-parse", "HEAD"])).toBe(head);
    expect(gitText(other, ["for-each-ref", "refs/heads", "refs/remotes"])).toBe(branches);
    expect(gitText(other, ["for-each-ref", "refs/vault-sync"])).toContain("refs/vault-sync/backups/origin/backup/machine-a/");
  }, 30_000);
});

describe("listing", () => {
  test("three machines' branches are listed, and snapshots filter by path", async () => {
    const { sb, repo } = seeded();
    const ea = engine("machine-a");
    put(repo, "notes/a.md", "a1\n");
    const first = await backup(ea, repo);
    put(repo, "notes/other.md", "o\n");
    const second = await backup(ea, repo);

    const c2 = clone(sb, "c2");
    const c3 = clone(sb, "c3");
    for (const [name, dir] of [["machine-b", c2], ["machine-c", c3]] as const) {
      put(dir, "notes/a.md", `from ${name}\n`);
      await backup(engine(name), dir);
    }
    const viewer = clone(sb, "viewer");
    const list = await engine("machine-v").listBackups(viewer);
    expect(list.map((b) => b.machine)).toEqual(["machine-a", "machine-b", "machine-c"]);
    for (const entry of list) {
      expect(entry.checkout).toMatch(/\S/);
      expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.protectedThrough).toBeGreaterThan(0);
    }
    const a = list[0]!;
    const all = await engine("machine-v").listSnapshots(viewer, a.branch);
    expect(all.map((s) => s.id)).toEqual([second, first]);
    const onlyOther = await engine("machine-v").listSnapshots(viewer, `refs/heads/${a.branch}`, "notes/other.md");
    expect(onlyOther.map((s) => s.id)).toEqual([second]);
  }, 30_000);
});

describe("containment and guards", () => {
  test("a symlinked folder on the way, a symlinked target and unsafe paths are refused", async () => {
    const { repo } = seeded();
    const e = engine("machine-a");
    put(repo, "notes/a.md", "x\n");
    const snap = await backup(e, repo);
    const outside = mkdtempSync(join(tmpdir(), "vault-sync-outside-"));
    sandboxes.push({ dir: outside, repo: "", remote: "", cleanup: () => rmSync(outside, { recursive: true, force: true }) });
    const real = realpathSync(outside);
    rmSync(join(repo, "notes"), { recursive: true });
    symlinkSync(real, join(repo, "notes"));
    await expect(e.restoreFile(repo, snap, "notes/a.md")).rejects.toMatchObject({ reason: "beyond-symlink" });
    expect(readdirSync(real)).toEqual([]);

    rmSync(join(repo, "notes"));
    mkdirSync(join(repo, "notes"));
    symlinkSync(join(real, "target.md"), join(repo, "notes/a.md"));
    await expect(e.restoreFile(repo, snap, "notes/a.md")).rejects.toMatchObject({ reason: "beyond-symlink" });
    await expect(e.restoreFile(repo, snap, "notes/a.md", { overwrite: true })).rejects.toBeInstanceOf(RestoreRefusedError);
    expect(readdirSync(real)).toEqual([]);

    for (const bad of ["../x.md", "/etc/x", "notes/../../x", ".git/config", "a\0b"]) {
      await expect(e.restoreFile(repo, snap, "notes/a.md", { targetPath: bad })).rejects.toMatchObject({ reason: "unsafe-path" });
    }
  }, 30_000);

  test("a cloud-synced worktree is refused even when backup was never enabled", async () => {
    const { sb, repo } = seeded();
    const e = engine("machine-a");
    put(repo, "notes/a.md", "x\n");
    const snap = await backup(e, repo);
    const home = realpathSync(mkdtempSync(join(tmpdir(), "vault-sync-home-")));
    sandboxes.push({ dir: home, repo: "", remote: "", cleanup: () => rmSync(home, { recursive: true, force: true }) });
    const cloudParent = join(home, "Library", "CloudStorage", "OneDrive-Example");
    mkdirSync(cloudParent, { recursive: true });
    const inCloud = join(cloudParent, "vault");
    git(sb.dir, ["clone", "-q", sb.remote, inCloud]);
    const strict = createBackupEngine({ machineId: "machine-b", gitEnv: isolatedGitEnv, ...permissiveGuards, homeDir: home, platform: "darwin" });
    for (const call of [
      () => strict.listBackups(inCloud),
      () => strict.restoreFile(inCloud, snap, "notes/a.md"),
      () => strict.readAtSnapshot(inCloud, snap, "notes/a.md"),
    ]) {
      const error = await call().then(() => null, (err) => err);
      expect(error).toBeInstanceOf(BackupRefusedError);
      expect((error as BackupRefusedError).reason).toBe("cloud-synced-location");
    }
    expect(readdirSync(join(inCloud, "notes"))).toEqual(["a.md"]);
    expect(readFileSync(join(inCloud, "notes/a.md"), "utf8")).toBe("alpha\n");
  }, 30_000);
});

describe("fix round", () => {
  test("listing never touches the user's remote-tracking refs", async () => {
    const { sb, repo } = seeded();
    const viewer = clone(sb, "viewer");
    put(repo, "notes/a.md", "later backup\n");
    await backup(engine("machine-a"), repo);
    const before = gitText(viewer, ["for-each-ref", "refs/remotes"]);
    expect(before).not.toContain("backup/");
    const list = await engine("machine-v").listBackups(viewer);
    expect(list).toHaveLength(1);
    expect(gitText(viewer, ["for-each-ref", "refs/remotes"])).toBe(before);
  });

  test("a file that appears between the check and the publish is never overwritten", async () => {
    const { repo } = seeded();
    const e = engine("machine-a");
    put(repo, "notes/a.md", "backed up\n");
    const snap = await backup(e, repo);
    rmSync(join(repo, "notes/a.md"));

    let fired = 0;
    restoreTestHooks.beforePublish = (file) => {
      if (fired++ === 0) writeFileSync(file, "autosave won the race\n");
    };
    const res = await e.restoreFile(repo, snap, "notes/a.md");
    expect(res.sibling).toBe(true);
    expect(readFileSync(join(repo, "notes/a.md"), "utf8")).toBe("autosave won the race\n");
    expect(readFileSync(join(repo, res.path), "utf8")).toBe("backed up\n");

    rmSync(join(repo, "notes/a.md"));
    fired = 0;
    await expect(e.restoreFile(repo, snap, "notes/a.md", { targetPath: "notes/a.md" })).rejects.toMatchObject({ reason: "target-exists" });
    expect(readFileSync(join(repo, "notes/a.md"), "utf8")).toBe("autosave won the race\n");
    expect(readdirSync(join(repo, "notes")).filter((n) => n.startsWith(".vsr-"))).toEqual([]);
  });

  test("listing snapshots stops at the first commit that is not a snapshot", async () => {
    const { repo } = seeded();
    const parent = gitText(repo, ["rev-parse", "HEAD"]);
    let script = "";
    for (let i = 0; i < 450; i += 1) {
      script += `commit refs/heads/main\ncommitter T <t@example.invalid> ${1700000000 + i} +0000\ndata 3\nx${i % 10}\n${i === 0 ? `from ${parent}\n` : ""}\n`;
    }
    git(repo, ["fast-import", "--quiet"], script);
    const e = engine("machine-a");
    put(repo, "notes/a.md", "chain\n");
    const first = await backup(e, repo);
    put(repo, "notes/b.md", "chain2\n");
    const second = await backup(e, repo);
    const [entry] = await e.listBackups(repo);
    expect((await e.listSnapshots(repo, entry!.branch)).map((s) => s.id)).toEqual([second, first]);
    expect((await e.listSnapshots(repo, entry!.branch, "notes/b.md")).map((s) => s.id)).toEqual([second]);
    expect(await e.listSnapshots(repo, entry!.branch, undefined, { limit: 1 })).toHaveLength(1);
  });

  test("a differently cased existing folder is not mistaken for a symlink escape", async () => {
    const { repo } = seeded();
    const e = engine("machine-a");
    put(repo, "notes/a.md", "x\n");
    const snap = await backup(e, repo);
    if (existsSync(join(repo, "NOTES"))) return; // case-sensitive volume: nothing to check
    const res = await e.restoreFile(repo, snap, "notes/a.md", { targetPath: "Notes/b.md" });
    expect(res.state).toBe("restored");
    expect(readFileSync(join(repo, "notes/b.md"), "utf8")).toBe("x\n");
  });

  test("folders created for a refused restore are removed, and existing ones kept", async () => {
    const { repo } = seeded();
    const e = engine("machine-a");
    put(repo, "notes/a.md", "x\n");
    const snap = await backup(e, repo);
    restoreTestHooks.beforePublish = () => {
      throw new RestoreRefusedError("unsafe-path", "refused");
    };
    await expect(e.restoreFile(repo, snap, "notes/a.md", { targetPath: "fresh/deep/er/x.md" })).rejects.toBeInstanceOf(RestoreRefusedError);
    expect(existsSync(join(repo, "fresh"))).toBe(false);
    expect(readdirSync(join(repo, "notes")).filter((n) => n.startsWith(".vsr-"))).toEqual([]);
    await expect(e.restoreFile(repo, snap, "notes/a.md", { targetPath: "notes/new/x.md" })).rejects.toBeInstanceOf(RestoreRefusedError);
    expect(existsSync(join(repo, "notes"))).toBe(true);
    expect(existsSync(join(repo, "notes/new"))).toBe(false);
  });

  test("restore temp files are outside any backup scope", () => {
    const scope = compileScope({ include: ["notes"] });
    expect(scope.isExcluded("notes/.vsr-0123456789abcdef.tmp")).toBe(true);
    expect(scope.isExcluded(".vsr-0123456789abcdef.tmp")).toBe(true);
    expect(scope.isExcluded("notes/vsr-0123456789abcdef.tmp")).toBe(false);
    expect(scope.isExcluded("notes/a.tmp")).toBe(false);
  });

  test("every spelling of .git is refused in any path component", async () => {
    for (const name of [".git", ".GIT", ".g\u200cit", "\u200c.git", ".git ", ".git.", ".git. .", "GIT~1", "git~1 ", ".git::$INDEX_ALLOCATION", ".gi\ufefft"]) {
      expect(isDotGitName(name)).toBe(true);
    }
    for (const name of [".gitignore", ".github", "git", "x.git", "git~2", ".gi t"]) expect(isDotGitName(name)).toBe(false);
    const { repo } = seeded();
    const e = engine("machine-a");
    put(repo, "notes/a.md", "x\n");
    const snap = await backup(e, repo);
    for (const bad of ["a/GIT~1/x", "notes/.git /x", ".g\u200cit/config"]) {
      await expect(e.restoreFile(repo, snap, "notes/a.md", { targetPath: bad })).rejects.toMatchObject({ reason: "unsafe-path" });
    }
  });
});

describe("second fix round", () => {
  test("a folder swapped for a symlink after publish: refused, outside same-named file survives", async () => {
    const { repo } = seeded();
    const e = engine("machine-a");
    put(repo, "notes/a.md", "backed up\n");
    const snap = await backup(e, repo);
    rmSync(join(repo, "notes/a.md"));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "vault-sync-outside-")));
    sandboxes.push({ dir: outside, repo: "", remote: "", cleanup: () => rmSync(outside, { recursive: true, force: true }) });
    writeFileSync(join(outside, "a.md"), "precious outside\n");
    restoreTestHooks.afterPublish = () => {
      renameSync(join(repo, "notes"), join(repo, "notes-moved"));
      symlinkSync(outside, join(repo, "notes"));
    };
    await expect(e.restoreFile(repo, snap, "notes/a.md")).rejects.toMatchObject({ reason: "beyond-symlink" });
    expect(readFileSync(join(outside, "a.md"), "utf8")).toBe("precious outside\n");
    // Our published file sits in the moved folder, inside the worktree and unreachable by the old path; it is left alone.
    expect(readFileSync(join(repo, "notes-moved/a.md"), "utf8")).toBe("backed up\n");
  });

  test("without hard links the fallback still never overwrites a file that appears first", async () => {
    const { repo } = seeded();
    const e = engine("machine-a");
    put(repo, "notes/a.md", "backed up\n");
    const snap = await backup(e, repo);
    rmSync(join(repo, "notes/a.md"));
    restoreTestHooks.forceNoLink = true;
    // Plain fallback publish.
    const plain = await e.restoreFile(repo, snap, "notes/a.md");
    expect(plain).toMatchObject({ state: "restored", sibling: false });
    rmSync(join(repo, "notes/a.md"));
    // Race after the fallback's own existence check.
    let fired = 0;
    restoreTestHooks.afterFallbackCheck = (file) => {
      if (fired++ === 0) writeFileSync(file, "autosave won the race\n");
    };
    const res = await e.restoreFile(repo, snap, "notes/a.md");
    expect(res.sibling).toBe(true);
    expect(readFileSync(join(repo, "notes/a.md"), "utf8")).toBe("autosave won the race\n");
    expect(readFileSync(join(repo, res.path), "utf8")).toBe("backed up\n");
    expect(readdirSync(join(repo, "notes")).filter((n) => n.startsWith(".vsr-"))).toEqual([]);
  });

  test("the snapshot walk stops at the first user commit instead of reading the whole history", async () => {
    const { repo } = seeded();
    const parent = gitText(repo, ["rev-parse", "HEAD"]);
    let script = "";
    for (let i = 0; i < 450; i += 1) {
      script += `commit refs/heads/main\ncommitter T <t@example.invalid> ${1700000000 + i} +0000\ndata 3\nx${i % 10}\n${i === 0 ? `from ${parent}\n` : ""}\n`;
    }
    git(repo, ["fast-import", "--quiet"], script);
    const e = engine("machine-a");
    put(repo, "notes/a.md", "chain\n");
    const first = await backup(e, repo);
    const [entry] = await e.listBackups(repo);
    let logs = 0;
    restoreTestHooks.onSnapshotLog = () => { logs += 1; };
    expect((await e.listSnapshots(repo, entry!.branch)).map((s) => s.id)).toEqual([first]);
    expect(logs).toBe(1);
    logs = 0;
    expect((await e.listSnapshots(repo, entry!.branch, "notes/a.md")).map((s) => s.id)).toEqual([first]);
    expect(logs).toBe(1);
  });

  test("a file name too long for the folder is refused with name-too-long", async () => {
    const { repo } = seeded();
    const e = engine("machine-a");
    const long = `${"n".repeat(244)}.md`;
    put(repo, `notes/${long}`, "long\n");
    const snap = await backup(e, repo);
    // A sibling name would exceed the 255-byte limit.
    put(repo, `notes/${long}`, "changed\n");
    await expect(e.restoreFile(repo, snap, `notes/${long}`)).rejects.toMatchObject({ reason: "name-too-long" });
    await expect(e.restoreFile(repo, snap, `notes/${long}`, { targetPath: `notes/${"m".repeat(300)}.md` })).rejects.toMatchObject({ reason: "name-too-long" });
    expect(readdirSync(join(repo, "notes")).filter((n) => n.startsWith(".vsr-"))).toEqual([]);
  });
});
