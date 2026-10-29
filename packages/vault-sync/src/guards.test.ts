import { setDefaultTimeout, afterEach, describe, expect, test } from "bun:test";
setDefaultTimeout(30_000);
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BackupRefusedError, createBackupEngine, type BackupEngineOptions, type RemoteVisibility, type ScanBlob, type SecretScanResult } from "./index.ts";
import { git, gitText, isolatedGitEnv, sandbox, type Sandbox } from "./test-fixtures.ts";

const sandboxes: Sandbox[] = [];
afterEach(() => {
  while (sandboxes.length) sandboxes.pop()!.cleanup();
});

interface Harness extends Sandbox {
  home: string;
  clock: { t: number };
  visibility: { value: RemoteVisibility; calls: number };
  scans: ScanBlob[][];
  scanResult: { value: SecretScanResult | (() => never) };
}

function setup(): Harness {
  const sb = sandbox();
  sandboxes.push(sb);
  const home = join(sb.dir, "home");
  mkdirSync(home);
  return { ...sb, home, clock: { t: Date.UTC(2026, 2, 3, 9, 0, 0) }, visibility: { value: "private", calls: 0 }, scans: [], scanResult: { value: { findings: [] } } };
}

function engine(h: Harness, overrides: Partial<BackupEngineOptions> = {}) {
  return createBackupEngine({
    machineId: "test-machine",
    settleMs: 0,
    gitEnv: isolatedGitEnv,
    now: () => h.clock.t,
    homeDir: h.home,
    platform: "darwin",
    mountInfo: async () => null,
    remoteVisibility: async () => {
      h.visibility.calls += 1;
      return h.visibility.value;
    },
    secretScanner: async (blobs) => {
      h.scans.push(blobs);
      const r = h.scanResult.value;
      return typeof r === "function" ? r() : r;
    },
    ...overrides,
  });
}

function put(root: string, path: string, content: string | Buffer): void {
  const abs = join(root, ...path.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** Every object id and ref in a repository: a refused operation must leave both unchanged. */
function gitState(repo: string): string {
  const objects = gitText(repo, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"]);
  const refs = gitText(repo, ["for-each-ref", "--format=%(objectname) %(refname)"]);
  return `${objects}\n--\n${refs}`;
}

function remoteRefs(remote: string): string {
  return gitText(dirname(remote), ["--git-dir", remote, "for-each-ref", "--format=%(objectname) %(refname)"]);
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BackupRefusedError) return error.reason;
    throw error;
  }
  throw new Error("expected a refusal");
}

const scope = { include: ["notes"] };

describe("per-checkout enablement", () => {
  test("a checkout that was never enabled is refused and nothing is written to Git or the engine folder", async () => {
    const h = setup();
    put(h.repo, "notes/a.md", "a\n");
    const e = engine(h);
    const before = gitState(h.repo);
    expect(await refusal(e.capture(h.repo, scope))).toBe("not-enabled");
    expect(await e.pushBackup(h.repo)).toMatchObject({ state: "blocked", reason: "not-enabled" });
    expect(await e.verify(h.repo)).toMatchObject({ verified: false, state: "blocked", reason: "not-enabled" });
    expect(gitState(h.repo)).toBe(before);
    expect(existsSync(join(h.repo, ".git/vault-sync"))).toBe(false);
    expect((await e.status(h.repo)).block?.reason).toBe("not-enabled");
  });

  test("enable then disable: capture works only while enabled", async () => {
    const h = setup();
    put(h.repo, "notes/a.md", "a\n");
    const e = engine(h);
    expect(await e.enable(h.repo)).toMatchObject({ remote: "origin", visibility: "private" });
    expect((await e.capture(h.repo, scope)).committed).toBe(true);
    expect((await e.status(h.repo)).enabled).toBe(true);
    await e.disable(h.repo);
    put(h.repo, "notes/a.md", "a2\n");
    const before = gitState(h.repo);
    expect(await refusal(e.capture(h.repo, scope))).toBe("not-enabled");
    expect(gitState(h.repo)).toBe(before);
  });

  test("renaming the folder makes enablement stale until enabled again; the deadline keeps counting", async () => {
    const h = setup();
    put(h.repo, "notes/a.md", "a\n");
    const e = engine(h);
    await e.enable(h.repo);
    await e.noteEdit(h.repo, h.clock.t - 5000);
    const moved = join(h.dir, "vault renamed");
    renameSync(h.repo, moved);
    const before = gitState(moved);
    h.clock.t += 60_000;
    expect(await refusal(e.capture(moved, scope))).toBe("enablement-stale");
    expect(await e.pushBackup(moved)).toMatchObject({ state: "blocked", reason: "enablement-stale" });
    expect(gitState(moved)).toBe(before);
    const status = await e.status(moved);
    expect(status.block?.reason).toBe("enablement-stale");
    expect(status.protectionAgeSeconds).toBe(65);
    await e.enable(moved);
    expect((await e.capture(moved, scope)).committed).toBe(true);
  });

  test("changing the remote URL makes enablement stale", async () => {
    const h = setup();
    put(h.repo, "notes/a.md", "a\n");
    const e = engine(h);
    await e.enable(h.repo);
    expect((await e.capture(h.repo, scope)).committed).toBe(true);
    const other = join(h.dir, "other.git");
    git(h.dir, ["init", "-q", "--bare", other]);
    git(h.repo, ["remote", "set-url", "origin", other]);
    put(h.repo, "notes/a.md", "a2\n");
    const before = gitState(h.repo);
    expect(await refusal(e.capture(h.repo, scope))).toBe("enablement-stale");
    expect(await e.pushBackup(h.repo)).toMatchObject({ state: "blocked", reason: "enablement-stale" });
    expect(await e.verify(h.repo)).toMatchObject({ state: "blocked", reason: "enablement-stale" });
    expect(gitState(h.repo)).toBe(before);
    expect(remoteRefs(other)).toBe("");
  });
});

describe("cloud-synced folders", () => {
  test("a worktree reached through a symlinked parent that resolves into a cloud folder is refused", async () => {
    const h = setup();
    const cloud = join(h.home, "Library", "CloudStorage", "OneDrive-Example");
    mkdirSync(cloud, { recursive: true });
    const vault = join(cloud, "vault");
    git(cloud, ["init", "-q", "-b", "main", vault]);
    git(vault, ["remote", "add", "origin", h.remote]);
    put(vault, "notes/a.md", "a\n");
    const link = join(h.dir, "looks-local");
    symlinkSync(cloud, link);
    const viaLink = join(link, "vault");
    const e = engine(h);
    const before = gitState(vault);
    expect(await refusal(e.enable(viaLink))).toBe("cloud-synced-location");
    expect(await refusal(e.capture(viaLink, scope))).toBe("cloud-synced-location");
    expect(await e.pushBackup(viaLink)).toMatchObject({ state: "blocked", reason: "cloud-synced-location" });
    expect(await e.verify(viaLink)).toMatchObject({ state: "blocked", reason: "cloud-synced-location" });
    expect(gitState(vault)).toBe(before);
    expect(existsSync(join(vault, ".git/vault-sync"))).toBe(false);
  });

  test("a vault moved into a cloud folder after enablement stops on the next operation, by either path", async () => {
    const h = setup();
    put(h.repo, "notes/a.md", "a\n");
    const e = engine(h);
    await e.enable(h.repo);
    expect((await e.capture(h.repo, scope)).committed).toBe(true);
    expect((await e.pushBackup(h.repo)).state).toBe("pushed");
    await e.noteEdit(h.repo, h.clock.t);
    const remoteBefore = remoteRefs(h.remote);

    const cloud = join(h.home, "Dropbox");
    mkdirSync(cloud);
    const moved = join(cloud, "vault");
    renameSync(h.repo, moved);
    symlinkSync(moved, h.repo); // the old path still works, but now resolves into the cloud folder
    put(moved, "notes/a.md", "a2\n");
    const before = gitState(moved);
    h.clock.t += 30_000;
    for (const path of [h.repo, moved]) {
      expect(await refusal(e.capture(path, scope))).toBe("cloud-synced-location");
      expect(await e.pushBackup(path)).toMatchObject({ state: "blocked", reason: "cloud-synced-location" });
      expect(await e.verify(path)).toMatchObject({ state: "blocked", reason: "cloud-synced-location" });
    }
    expect(gitState(moved)).toBe(before);
    expect(remoteRefs(h.remote)).toBe(remoteBefore);
    const status = await e.status(moved);
    expect(status.block?.reason).toBe("cloud-synced-location");
    expect(status.protectionAgeSeconds).toBe(30);
  });

  test("a network mount is refused", async () => {
    const h = setup();
    put(h.repo, "notes/a.md", "a\n");
    let network = false;
    const e = engine(h, { mountInfo: async () => (network ? { mountPoint: h.dir, type: "smbfs", local: false } : null) });
    await e.enable(h.repo);
    network = true;
    const before = gitState(h.repo);
    expect(await refusal(e.capture(h.repo, scope))).toBe("cloud-synced-location");
    expect(gitState(h.repo)).toBe(before);
  });
});

test("a mount table that cannot be read refuses the folder (fail closed)", async () => {
  const h = setup();
  put(h.repo, "notes/a.md", "a\n");
  let broken = false;
  const e = engine(h, { mountInfo: async () => { if (broken) throw new Error("mount table unreadable"); return null; } });
  await e.enable(h.repo);
  broken = true;
  const before = gitState(h.repo);
  expect(await refusal(e.capture(h.repo, scope))).toBe("cloud-synced-location");
  expect(await e.pushBackup(h.repo)).toMatchObject({ state: "blocked", reason: "cloud-synced-location" });
  expect((await e.status(h.repo)).block?.reason).toBe("cloud-synced-location");
  expect(gitState(h.repo)).toBe(before);
});

describe("remote visibility", () => {
  test("enable refuses a public remote unless publishing is confirmed", async () => {
    const h = setup();
    h.visibility.value = "public";
    put(h.repo, "notes/a.md", "a\n");
    const e = engine(h);
    expect(await refusal(e.enable(h.repo))).toBe("public-remote-unconfirmed");
    expect(await refusal(e.capture(h.repo, scope))).toBe("not-enabled");
    expect(await e.enable(h.repo, { visibilityConfirmedPublic: true })).toMatchObject({ visibility: "public" });
    await e.capture(h.repo, scope);
    expect((await e.pushBackup(h.repo)).state).toBe("pushed");
  });

  test("unknown visibility holds the push back but capture continues; the deadline keeps counting", async () => {
    const h = setup();
    h.visibility.value = "unknown";
    put(h.repo, "notes/a.md", "a\n");
    const e = engine(h);
    expect((await e.enable(h.repo)).visibility).toBe("unknown");
    const captured = await e.capture(h.repo, scope);
    expect(captured.committed).toBe(true);
    h.clock.t += 20_000;
    const pushed = await e.pushBackup(h.repo);
    expect(pushed).toMatchObject({ state: "blocked", reason: "visibility-unknown" });
    expect(remoteRefs(h.remote)).toBe("");
    const status = await e.status(h.repo);
    expect(status.block?.reason).toBe("visibility-unknown");
    expect(status.oldestUnprotectedEdit).toBe(captured.startedAt);
    expect(status.protectionAgeSeconds).toBe(20);
    expect(status.lastPushed).toBeNull();
    // Unknown is not remembered: the next push asks again and goes through once the answer is known.
    const calls = h.visibility.calls;
    h.visibility.value = "private";
    expect((await e.pushBackup(h.repo)).state).toBe("pushed");
    expect(h.visibility.calls).toBe(calls + 1);
  });

  test("visibility is rechecked at most every 10 minutes; a change to public pauses the push", async () => {
    const h = setup();
    put(h.repo, "notes/a.md", "a\n");
    const e = engine(h);
    await e.enable(h.repo);
    expect(h.visibility.calls).toBe(1);
    await e.capture(h.repo, scope);
    expect((await e.pushBackup(h.repo)).state).toBe("pushed");
    expect((await e.verify(h.repo)).verified).toBe(true);
    expect(h.visibility.calls).toBe(1);

    h.visibility.value = "public";
    put(h.repo, "notes/a.md", "a2\n");
    h.clock.t += 5 * 60_000;
    const second = await e.capture(h.repo, scope);
    expect((await e.pushBackup(h.repo)).state).toBe("pushed"); // cached answer still fresh
    expect(h.visibility.calls).toBe(1);
    expect((await e.verify(h.repo)).verified).toBe(true);

    put(h.repo, "notes/a.md", "a3\n");
    h.clock.t += 5 * 60_000;
    const third = await e.capture(h.repo, scope);
    const remoteBefore = remoteRefs(h.remote);
    const held = await e.pushBackup(h.repo);
    expect(held).toMatchObject({ state: "blocked", reason: "public-remote-unconfirmed" });
    expect(h.visibility.calls).toBe(2);
    expect(remoteRefs(h.remote)).toBe(remoteBefore);
    expect(remoteBefore).toContain(second.snapshot!);
    const status = await e.status(h.repo);
    expect(status.block?.reason).toBe("public-remote-unconfirmed");
    expect(status.oldestUnprotectedEdit).toBe(third.startedAt);
    expect(status.lastVerifiedSnapshot).toBe(second.snapshot);
  });
});

describe("secret scan before push", () => {
  test("a finding blocks the push, reports paths and rule ids only, and leaves the deadline as it was", async () => {
    const h = setup();
    put(h.repo, "notes/a.md", "plain\n");
    h.scanResult.value = { findings: [{ path: "notes/keys.md", rule: "example-rule" }] };
    const e = engine(h);
    await e.enable(h.repo);
    put(h.repo, "notes/keys.md", "pretend this is a credential\n");
    const captured = await e.capture(h.repo, scope);
    h.clock.t += 15_000;
    const pushed = await e.pushBackup(h.repo);
    expect(pushed).toMatchObject({ state: "blocked", reason: "secret-found", findings: [{ path: "notes/keys.md", rule: "example-rule" }] });
    expect(JSON.stringify(pushed)).not.toContain("pretend this is a credential");
    expect(remoteRefs(h.remote)).toBe("");
    expect(h.scans[0]!.map((b) => b.path).sort()).toEqual(["notes/a.md", "notes/keys.md"]);
    const status = await e.status(h.repo);
    expect(status.block).toMatchObject({ reason: "secret-found", findings: [{ path: "notes/keys.md", rule: "example-rule" }] });
    expect(status.oldestUnprotectedEdit).toBe(captured.startedAt);
    expect(status.protectionAgeSeconds).toBe(15);
    expect(status.lastPushed).toBeNull();
    expect((await e.verify(h.repo)).verified).toBe(false);

    // Removing the file lets the next push through; that push clears the held-back reason.
    h.scanResult.value = { findings: [] };
    expect((await e.pushBackup(h.repo)).state).toBe("pushed");
    expect((await e.status(h.repo)).block).toBeNull();
  });

  test("every blob of the chain is scanned before each push, whatever the destination holds; user commits are not part of a push", async () => {
    const h = setup();
    put(h.repo, "notes/a.md", "first\n");
    const e = engine(h);
    await e.enable(h.repo);
    await e.capture(h.repo, scope);
    expect((await e.pushBackup(h.repo)).state).toBe("pushed");
    expect((await e.verify(h.repo)).verified).toBe(true);

    put(h.repo, "outside/committed.txt", "committed by the user, outside scope\n");
    git(h.repo, ["add", "outside/committed.txt"]);
    git(h.repo, ["commit", "-q", "-m", "user commit"]);
    put(h.repo, "notes/b.md", "second\n");
    h.scans.length = 0;
    await e.capture(h.repo, scope);
    expect((await e.pushBackup(h.repo)).state).toBe("pushed");
    // The destination already holds a.md, but it may drop it before the push; it is scanned again.
    expect(h.scans[0]!.map((b) => b.path).sort()).toEqual(["notes/a.md", "notes/b.md"]);
  });

  test("a destination branch with unrelated history never narrows the scan below what the push sends", async () => {
    const h = setup();
    put(h.repo, "notes/old.md", "already published on main\n");
    git(h.repo, ["add", "notes/old.md"]);
    git(h.repo, ["commit", "-q", "-m", "published"]);
    git(h.repo, ["push", "-q", "origin", "main"]);
    put(h.repo, "notes/a.md", "draft\n");
    const e = engine(h);
    await e.enable(h.repo);
    await e.capture(h.repo, scope);
    expect((await e.pushBackup(h.repo)).state).toBe("pushed");
    // Git does not look inside unrelated advertised history when choosing what to send, and neither does
    // the scan: the blob main already holds is scanned again, which errs on the safe side.
    expect(h.scans[0]!.map((b) => b.path).sort()).toEqual(["notes/a.md", "notes/old.md"]);
  });

  test("new blobs above the total scan limit hold the push back", async () => {
    const h = setup();
    const e = engine(h, { maxScanTotalBytes: 150 });
    await e.enable(h.repo);
    put(h.repo, "notes/a.md", "a".repeat(100));
    put(h.repo, "notes/b.md", "b".repeat(100));
    await e.capture(h.repo, scope);
    expect(await e.pushBackup(h.repo)).toMatchObject({ state: "blocked", reason: "too-large-to-scan" });
    expect(remoteRefs(h.remote)).toBe("");
    expect(h.scans.length).toBe(0);
  });

  test("an unavailable or failing scanner blocks the push", async () => {
    const h = setup();
    put(h.repo, "notes/a.md", "a\n");
    const e = engine(h);
    await e.enable(h.repo);
    await e.capture(h.repo, scope);
    h.scanResult.value = { unavailable: "gitleaks is not installed" };
    expect(await e.pushBackup(h.repo)).toMatchObject({ state: "blocked", reason: "scanner-unavailable" });
    h.scanResult.value = () => { throw new Error("scanner crashed"); };
    expect(await e.pushBackup(h.repo)).toMatchObject({ state: "blocked", reason: "scanner-unavailable" });
    expect(remoteRefs(h.remote)).toBe("");
    expect((await e.status(h.repo)).block?.reason).toBe("scanner-unavailable");
  });

  test("a text blob above the scan limit blocks the push; a binary one is pushed and listed as not scanned", async () => {
    const h = setup();
    const e = engine(h, { maxScanBlobBytes: 100 });
    await e.enable(h.repo);
    put(h.repo, "notes/image.bin", Buffer.concat([Buffer.from([0, 1, 2]), Buffer.alloc(200, 7)]));
    await e.capture(h.repo, scope);
    const binary = await e.pushBackup(h.repo);
    expect(binary.state).toBe("pushed");
    expect(binary.state === "pushed" && binary.notScanned.map((b) => b.path)).toEqual(["notes/image.bin"]);
    expect(h.scans[0]!.map((b) => b.path)).toEqual([]);

    put(h.repo, "notes/long.md", "x".repeat(200));
    await e.capture(h.repo, scope);
    const remoteBefore = remoteRefs(h.remote);
    const text = await e.pushBackup(h.repo);
    expect(text).toMatchObject({ state: "blocked", reason: "too-large-to-scan" });
    expect(text.state === "blocked" && text.notScanned?.map((b) => b.path)).toEqual(["notes/long.md"]);
    expect(remoteRefs(h.remote)).toBe(remoteBefore);
  });

  test("the enablement record holds no remote URL", async () => {
    const h = setup();
    git(h.repo, ["remote", "set-url", "origin", "https://user:token-value@example.invalid/owner/vault.git"]);
    const e = engine(h);
    await e.enable(h.repo);
    const text = readFileSync(join(h.repo, ".git/vault-sync/enablement.json"), "utf8");
    expect(text).not.toContain("token-value");
    expect(text).not.toContain(h.remote);
  });
});
