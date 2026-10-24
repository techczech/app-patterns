import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BackupRefusedError, createBackupEngine, RestoreRefusedError, type BackupEngineOptions } from "./index.ts";
import { autoEnabled, git, gitText, isolatedGitEnv, permissiveGuards, sandbox, type Sandbox } from "./test-fixtures.ts";

const sandboxes: Sandbox[] = [];
afterEach(() => {
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
  });

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
  });

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
  });
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
  });
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
  });

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
  });
});
