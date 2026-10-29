import { setDefaultTimeout, afterEach, describe, expect, test } from "bun:test";
setDefaultTimeout(30_000);
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BackupRefusedError, createBackupEngine, type BackupEngineOptions, type ScanBlob } from "./index.ts";
import { supportedAddress } from "./destination.ts";
import { createGitRunner } from "./git-process.ts";
import { git, gitText, isolatedGitEnv, sandbox, type Sandbox } from "./test-fixtures.ts";

const sandboxes: Sandbox[] = [];
afterEach(() => {
  while (sandboxes.length) sandboxes.pop()!.cleanup();
});

interface Harness extends Sandbox {
  visibilityAsked: string[];
  scans: ScanBlob[][];
}

function setup(): Harness {
  const sb = sandbox();
  sandboxes.push(sb);
  return { ...sb, visibilityAsked: [], scans: [] };
}

/** Destinations whose path contains "public" are public; any blob containing DENY is a finding. */
function engine(h: Harness, overrides: Partial<BackupEngineOptions> = {}) {
  return createBackupEngine({
    machineId: "test-machine",
    settleMs: 0,
    gitEnv: isolatedGitEnv,
    homeDir: join(h.dir, "home"),
    mountInfo: async () => null,
    remoteVisibility: async (url) => {
      h.visibilityAsked.push(url);
      return url.includes("public") ? "public" : "private";
    },
    secretScanner: async (blobs) => {
      h.scans.push(blobs);
      const hit = blobs.filter((b) => b.bytes.includes("DENY"));
      return { findings: hit.map((b) => ({ path: b.path, rule: "test-deny" })) };
    },
    ...overrides,
  });
}

function put(root: string, path: string, content: string): void {
  const abs = join(root, ...path.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function bare(h: Harness, name: string): string {
  const path = join(h.dir, name);
  git(h.dir, ["init", "-q", "--bare", "-b", "main", path]);
  return path;
}

function refs(remote: string): string {
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

/** A harmless program that records that it ran. */
function markerProgram(h: Harness, name: string): { program: string; marker: string } {
  const marker = join(h.dir, `${name}.ran`);
  const program = join(h.dir, `${name}.sh`);
  writeFileSync(program, `#!/bin/sh\necho executed > '${marker}'\nexit 1\n`);
  chmodSync(program, 0o755);
  return { program, marker };
}

const scope = { include: ["notes"] };
const posix = process.platform !== "win32";

describe("one validated destination (review findings 1 and 7)", () => {
  test("a second push address is refused at enable and, if added later, holds every push back before anything is sent", async () => {
    const h = setup();
    const extra = bare(h, "public-mirror.git");
    git(h.repo, ["config", "--add", "remote.origin.pushurl", h.remote]);
    git(h.repo, ["config", "--add", "remote.origin.pushurl", extra]);
    put(h.repo, "notes/a.md", "draft\n");
    const e = engine(h);
    expect(await refusal(e.enable(h.repo))).toBe("unsupported-remote");
    expect(h.visibilityAsked).toEqual([]);

    git(h.repo, ["config", "--unset-all", "remote.origin.pushurl"]);
    await e.enable(h.repo);
    await e.capture(h.repo, scope);
    git(h.repo, ["config", "--add", "remote.origin.pushurl", h.remote]);
    git(h.repo, ["config", "--add", "remote.origin.pushurl", extra]);
    expect(await e.pushBackup(h.repo)).toMatchObject({ state: "blocked", reason: "unsupported-remote" });
    expect(refs(h.remote)).toBe("");
    expect(refs(extra)).toBe("");
    expect(h.visibilityAsked.some((url) => url.includes("public"))).toBe(false);
  });

  test("a second fetch address is refused too", async () => {
    const h = setup();
    git(h.repo, ["config", "--add", "remote.origin.url", bare(h, "other.git")]);
    expect(await refusal(engine(h).enable(h.repo))).toBe("unsupported-remote");
  });

  test("a push address that differs from the fetch address is refused, so verify can only observe where the push went", async () => {
    const h = setup();
    const pushTarget = bare(h, "push-target.git");
    put(h.repo, "notes/a.md", "draft\n");
    const e = engine(h);
    git(h.repo, ["remote", "set-url", "--push", "origin", pushTarget]);
    expect(await refusal(e.enable(h.repo))).toBe("unsupported-remote");

    git(h.repo, ["config", "--unset-all", "remote.origin.pushurl"]);
    await e.enable(h.repo);
    await e.capture(h.repo, scope);
    expect((await e.pushBackup(h.repo)).state).toBe("pushed");
    // The fetch side now points at a copy that holds the branch; the push side is the original.
    const copy = join(h.dir, "copy.git");
    git(h.dir, ["clone", "-q", "--bare", h.remote, copy]);
    git(h.repo, ["remote", "set-url", "origin", copy]);
    git(h.repo, ["remote", "set-url", "--push", "origin", h.remote]);
    expect(await e.verify(h.repo)).toMatchObject({ verified: false, state: "blocked", reason: "unsupported-remote" });
    expect((await e.status(h.repo)).lastVerifiedSnapshot).toBeNull();
  });

  test("verify reads the destination itself: a branch missing there is not verified", async () => {
    const h = setup();
    put(h.repo, "notes/a.md", "draft\n");
    const e = engine(h);
    await e.enable(h.repo);
    const captured = await e.capture(h.repo, scope);
    expect((await e.pushBackup(h.repo)).state).toBe("pushed");
    git(h.dir, ["--git-dir", h.remote, "update-ref", "-d", captured.ref!]);
    expect(await e.verify(h.repo)).toMatchObject({ verified: false, state: "missing-on-remote" });
  });

  test("only HTTPS, file:// and absolute local addresses are supported", () => {
    expect(supportedAddress("https://github.com/owner/vault.git", "darwin")).toBe(true);
    expect(supportedAddress("file:///srv/vault.git", "darwin")).toBe(true);
    expect(supportedAddress("/srv/vault.git", "darwin")).toBe(true);
    for (const url of ["git@github.com:owner/vault.git", "ssh://host/vault.git", "http://host/vault.git", "git://host/vault.git", "ext::sh -c x", "foo::https://host/x", "relative/path", "file://host/x"]) {
      expect(supportedAddress(url, "darwin")).toBe(false);
    }
    expect(supportedAddress("C:\\vaults\\backup.git", "win32")).toBe(true);
  });
});

describe("the secret scan's view of the destination (review finding 2)", () => {
  test("remote-tracking refs do not excuse history from the scan when the destination lacks it", async () => {
    const h = setup();
    put(h.repo, "notes/a.md", "DENY marker\n");
    const e = engine(h);
    await e.enable(h.repo);
    const first = await e.capture(h.repo, scope);
    expect(await e.pushBackup(h.repo)).toMatchObject({ state: "blocked", reason: "secret-found" });
    // A tracking ref names that unpushed snapshot (as a fetch from some other address would), then the
    // file is cleaned. The next push would carry the first snapshot as history.
    git(h.repo, ["update-ref", "refs/remotes/origin/main", first.snapshot!]);
    put(h.repo, "notes/a.md", "clean\n");
    await e.capture(h.repo, scope);
    expect(await e.pushBackup(h.repo)).toMatchObject({ state: "blocked", reason: "secret-found" });
    expect(h.scans[1]!.map((b) => b.path).sort()).toEqual(["notes/a.md", "notes/a.md"]);
    expect(refs(h.remote)).toBe("");
  });

  test("after re-enabling with a new empty destination, the whole chain is scanned again before it is sent", async () => {
    const h = setup();
    put(h.repo, "notes/a.md", "draft\n");
    const e = engine(h);
    await e.enable(h.repo);
    await e.capture(h.repo, scope);
    expect((await e.pushBackup(h.repo)).state).toBe("pushed");
    expect((await e.verify(h.repo)).verified).toBe(true);

    const fresh = bare(h, "fresh.git");
    git(h.repo, ["remote", "set-url", "origin", fresh]);
    expect(await e.pushBackup(h.repo)).toMatchObject({ state: "blocked", reason: "enablement-stale" });
    await e.enable(h.repo);
    expect((await e.pushBackup(h.repo)).state).toBe("pushed");
    expect(h.scans.map((batch) => batch.map((b) => b.path))).toEqual([["notes/a.md"], ["notes/a.md"]]);
  });
});

describe("repository configuration cannot choose programs for the engine (review finding 11)", () => {
  test.if(posix)("a receive-pack program configured on the remote is refused and never run", async () => {
    const h = setup();
    const { program, marker } = markerProgram(h, "receivepack");
    put(h.repo, "notes/a.md", "draft\n");
    const e = engine(h);
    git(h.repo, ["config", "remote.origin.receivepack", program]);
    expect(await refusal(e.enable(h.repo))).toBe("unsupported-remote");
    git(h.repo, ["config", "--unset", "remote.origin.receivepack"]);
    await e.enable(h.repo);
    await e.capture(h.repo, scope);
    git(h.repo, ["config", "remote.origin.receivepack", program]);
    expect(await e.pushBackup(h.repo)).toMatchObject({ state: "blocked", reason: "unsupported-remote" });
    expect(existsSync(marker)).toBe(false);
  });

  test.if(posix)("an upload-pack program configured on the remote is never run by restore", async () => {
    const h = setup();
    const { program, marker } = markerProgram(h, "uploadpack");
    git(h.repo, ["config", "remote.origin.uploadpack", program]);
    expect(await refusal(engine(h).listBackups(h.repo))).toBe("unsupported-remote");
    expect(existsSync(marker)).toBe(false);
  });

  test.if(posix)("even when the engine's own checks are bypassed, Git is told which far-side program to run", async () => {
    // The runner alone, as the engine invokes it: --receive-pack overrides the repository's setting.
    const h = setup();
    const { program, marker } = markerProgram(h, "receivepack-direct");
    put(h.repo, "notes/a.md", "draft\n");
    git(h.repo, ["add", "-A"]);
    git(h.repo, ["commit", "-q", "-m", "x"]);
    git(h.repo, ["config", "remote.origin.receivepack", program]);
    const runner = createGitRunner({ hooksDir: join(h.dir, "no-hooks"), env: isolatedGitEnv });
    const result = await runner.run(["push", "--receive-pack=git-receive-pack", "origin", "main:main"], { cwd: h.repo, timeoutMs: 20_000, maxOutputBytes: 1 << 20 });
    expect(result.code).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  test.if(posix)("SSH commands, remote helpers and repository credential helpers do not run; trusted helpers do", async () => {
    const h = setup();
    const ssh = markerProgram(h, "ssh");
    const helper = markerProgram(h, "helper");
    const trusted = markerProgram(h, "trusted");
    git(h.repo, ["config", "core.sshCommand", ssh.program]);
    git(h.repo, ["config", "credential.helper", `!${helper.program}`]);
    const run = { cwd: h.repo, timeoutMs: 20_000, maxOutputBytes: 1 << 20 };
    const plain = createGitRunner({ hooksDir: join(h.dir, "no-hooks"), env: isolatedGitEnv });
    const viaSsh = await plain.run(["ls-remote", "ssh://example.invalid/vault.git"], run);
    expect(viaSsh.code).not.toBe(0);
    expect(viaSsh.stderr).toContain("not allowed");
    expect((await plain.run(["ls-remote", `ext::${ssh.program}`], run)).code).not.toBe(0);
    expect(existsSync(ssh.marker)).toBe(false);
    const input = Buffer.from("protocol=https\nhost=example.invalid\n\n");
    expect((await plain.run(["credential", "fill"], { ...run, input })).code).not.toBe(0);
    expect(existsSync(helper.marker)).toBe(false);
    const withTrusted = createGitRunner({ hooksDir: join(h.dir, "no-hooks"), env: isolatedGitEnv, credentialHelpers: [`!${trusted.program}`] });
    await withTrusted.run(["credential", "fill"], { ...run, input });
    expect(existsSync(trusted.marker)).toBe(true);
    expect(existsSync(helper.marker)).toBe(false);
  });
});

describe("restore reads the checkout's own destination (review finding 9)", () => {
  test("backups pushed to a per-checkout remote are listed from that remote; a fresh checkout names it", async () => {
    const h = setup();
    const destination = bare(h, "backup-destination.git");
    git(h.repo, ["remote", "add", "backup-destination", destination]);
    put(h.repo, "notes/a.md", "draft\n");
    const e = engine(h);
    await e.enable(h.repo, { remote: "backup-destination" });
    const captured = await e.capture(h.repo, scope);
    expect((await e.pushBackup(h.repo)).state).toBe("pushed");
    expect((await e.verify(h.repo)).verified).toBe(true);
    expect(refs(h.remote)).toBe("");
    const listed = await e.listBackups(h.repo);
    expect(listed.map((b) => b.tip)).toEqual([captured.snapshot!]);

    const clone = join(h.dir, "clone");
    git(h.dir, ["init", "-q", "-b", "main", clone]);
    git(clone, ["remote", "add", "origin", h.remote]);
    git(clone, ["remote", "add", "backup-destination", destination]);
    expect(await e.listBackups(clone)).toEqual([]);
    const named = await e.listBackups(clone, { remote: "backup-destination" });
    expect(named.map((b) => b.tip)).toEqual([captured.snapshot!]);
    const snaps = await e.listSnapshots(clone, named[0]!.branch, undefined, { remote: "backup-destination" });
    expect(snaps.map((s) => s.id)).toEqual([captured.snapshot!]);
  });
});
