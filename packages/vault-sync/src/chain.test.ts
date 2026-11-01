import { setDefaultTimeout, afterEach, describe, expect, test } from "bun:test";
setDefaultTimeout(30_000);
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BackupRefusedError, createBackupEngine, type BackupEngineOptions } from "./index.ts";
import { git, gitText, isolatedGitEnv, permissiveGuards, sandbox, type Sandbox } from "./test-fixtures.ts";

/** Review round 2, R1: an existing backup chain is extended or published only if this engine made all of it. */

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

function put(root: string, path: string, content: string): void {
  const abs = join(root, ...path.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

const remoteObjects = (remote: string) => gitText(dirname(remote), ["--git-dir", remote, "rev-list", "--objects", "--all"]);

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BackupRefusedError) return error.reason;
    throw error;
  }
  throw new Error("expected a refusal");
}

/** The engine identity, so a planted commit looks like a snapshot to anything but the recorded root. */
const engineIdentity = ["-c", "user.name=Automatic backup", "-c", "user.email=backup@vault-sync.invalid"];

describe("existing backup history (review round 2, R1)", () => {
  test("a chain from an older version, with the user's commit as a parent, is neither extended nor pushed", async () => {
    const { repo, remote } = setup();
    put(repo, "notes/a.md", "a\n");
    put(repo, ".writeflex/owner.lock", "synthetic coordination state\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-q", "-m", "user history"]);
    const e = engine();
    await e.enable(repo);
    const first = await e.capture(repo, { include: ["notes"] });
    // The shape an older engine made: a snapshot whose parent is HEAD.
    const legacy = gitText(repo, ["commit-tree", `${first.snapshot}^{tree}`, "-p", "HEAD", "-m", "Automatic backup legacy"]);
    git(repo, ["update-ref", first.ref!, legacy]);
    put(repo, "notes/a.md", "b\n");

    expect(await refusal(e.capture(repo, { include: ["notes"] }))).toBe("unsupported-history");
    expect(gitText(repo, ["rev-parse", first.ref!])).toBe(legacy);
    const pushed = await e.pushBackup(repo);
    expect(pushed).toMatchObject({ state: "blocked", reason: "unsupported-history" });
    expect(remoteObjects(remote)).toBe("");
    expect((await e.status(repo)).block?.reason).toBe("unsupported-history");
  });

  test("commits that look like snapshots are refused when their root was not recorded here", async () => {
    const { repo, remote } = setup();
    put(repo, "notes/a.md", "a\n");
    const e = engine();
    await e.enable(repo);
    const first = await e.capture(repo, { include: ["notes"] });
    const message = gitText(repo, ["log", "-1", "--format=%B", first.snapshot!]);
    // Same tree and message, engine identity, but a root this engine never recorded.
    const forged = gitText(repo, [...engineIdentity, "commit-tree", `${first.snapshot}^{tree}`, "-m", message, "-m", "planted"]);
    expect(forged).not.toBe(first.snapshot);
    git(repo, ["update-ref", first.ref!, forged]);
    expect(await refusal(e.capture(repo, { include: ["notes"] }))).toBe("unsupported-history");
    expect(await e.pushBackup(repo)).toMatchObject({ state: "blocked", reason: "unsupported-history" });
    expect(remoteObjects(remote)).toBe("");
  });

  test("a recorded chain keeps working across restarts, and a removed record stops it rather than starting over", async () => {
    const { repo, remote } = setup();
    put(repo, "notes/a.md", "a\n");
    let clock = Date.UTC(2026, 4, 1, 9, 0, 0);
    const first = engine({ now: () => clock });
    await first.enable(repo);
    await first.capture(repo, { include: ["notes"] });
    expect((await first.pushBackup(repo)).state).toBe("pushed");
    const chainFile = join(repo, ".git", "vault-sync", "chain.json");
    expect(JSON.parse(readFileSync(chainFile, "utf8")).roots).toHaveLength(1);

    clock += 86_400_000;
    put(repo, "notes/a.md", "a2\n");
    const second = engine({ now: () => clock });
    const next = await second.capture(repo, { include: ["notes"] });
    expect(next.committed).toBe(true);
    expect((await second.pushBackup(repo)).state).toBe("pushed");
    expect((await second.verify(repo)).verified).toBe(true);
    const objects = remoteObjects(remote);

    rmSync(chainFile);
    put(repo, "notes/a.md", "a3\n");
    expect(await refusal(second.capture(repo, { include: ["notes"] }))).toBe("unsupported-history");
    expect(remoteObjects(remote)).toBe(objects);
  });
});
