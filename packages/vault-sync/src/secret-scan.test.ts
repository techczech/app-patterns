import { setDefaultTimeout, afterEach, describe, expect, test } from "bun:test";
setDefaultTimeout(30_000);
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createBackupEngine, createGitleaksScanner } from "./index.ts";
import { git, isolatedGitEnv, sandbox, type Sandbox } from "./test-fixtures.ts";

const hasGitleaks = spawnSync("gitleaks", ["version"], { stdio: "ignore" }).status === 0;

// TEST FIXTURE, not a real credential: an AWS-style access key id shape, assembled at run time so the
// source file itself does not match a secret scanner's pattern.
const FAKE_KEY = ["AKIA", "QWERTYZXCVBNMPLK"].join("");
const FAKE_LINE = `aws_access_key_id = ${FAKE_KEY}`;
const FAKE_KEY_2 = ["AKIA", "ZXCVBNMQWERTYPLK"].join("");
const FAKE_LINE_2 = `aws_access_key_id = ${FAKE_KEY_2}`;

const sandboxes: Sandbox[] = [];
afterEach(() => {
  while (sandboxes.length) sandboxes.pop()!.cleanup();
});

function put(root: string, path: string, content: string): void {
  const abs = join(root, ...path.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

const scanDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith("vault-sync-scan-")).sort();

function engine(clock?: { t: number }) {
  return createBackupEngine({
    ...(clock ? { now: () => clock.t } : {}),
    machineId: "test-machine",
    settleMs: 0,
    gitEnv: isolatedGitEnv,
    homeDir: "/nonexistent-test-home",
    mountInfo: async () => null,
    remoteVisibility: async () => "private",
  });
}

describe("gitleaks scanner", () => {
  test("a bare name not found in the search folders, or a relative path, is reported as scanner missing", async () => {
    const blob = [{ path: "a.md", oid: "0".repeat(40), bytes: Buffer.from("x") }];
    expect(await createGitleaksScanner({ searchDirs: [tmpdir()] })(blob)).toEqual({ unavailable: "scanner missing: gitleaks is not installed" });
    expect(await createGitleaksScanner({ gitleaksPath: "bin/gitleaks" })(blob)).toEqual({ unavailable: "scanner missing: gitleaks is not installed" });
  });

  test("a missing binary reports the scanner as unavailable", async () => {
    const scanner = createGitleaksScanner({ gitleaksPath: "gitleaks-binary-that-does-not-exist" });
    expect(await scanner([{ path: "a.md", oid: "0".repeat(40), bytes: Buffer.from("x") }])).toEqual({ unavailable: "scanner missing: gitleaks is not installed" });
  });

  test.skipIf(!hasGitleaks)("the default scanner blocks a planted key in a new file and in an unpushed user commit, without echoing it", async () => {
    const sb = sandbox();
    sandboxes.push(sb);
    const clock = { t: Date.UTC(2026, 2, 3, 9, 0, 0) };
    const e = engine(clock);
    await e.enable(sb.repo);
    const dirsBefore = scanDirs();

    put(sb.repo, "notes/plain.md", "nothing to see\n");
    put(sb.repo, "notes/keys.md", `${FAKE_LINE}\n`);
    await e.capture(sb.repo, { include: ["notes"] });
    const firstCapture = clock.t;
    clock.t += 40_000;
    const first = await e.pushBackup(sb.repo);
    expect(first).toMatchObject({ state: "blocked", reason: "secret-found", findings: [{ path: "notes/keys.md", rule: "aws-access-token" }] });
    const held = await e.status(sb.repo);
    expect(held.oldestUnprotectedEdit).toBe(firstCapture);
    expect(held.protectionAgeSeconds).toBe(40);
    expect(held.block?.reason).toBe("secret-found");

    // The key leaves the scoped files but sits in an unpushed user commit that HEAD brings in.
    put(sb.repo, "notes/keys.md", "removed\n");
    put(sb.repo, "config/settings.ini", `${FAKE_LINE_2}\n`);
    git(sb.repo, ["add", "config/settings.ini"]);
    git(sb.repo, ["commit", "-q", "-m", "user commit with a key"]);
    await e.capture(sb.repo, { include: ["notes"] });
    const second = await e.pushBackup(sb.repo);
    expect(second.state).toBe("blocked");
    expect(second.state === "blocked" && second.findings?.map((f) => f.path).sort()).toEqual(["config/settings.ini", "notes/keys.md"]);

    clock.t += 20_000;
    const status = await e.status(sb.repo);
    expect(status.protectionAgeSeconds).toBe(60);
    expect(status.lastVerifiedSnapshot).toBeNull();
    const record = readFileSync(join(sb.repo, ".git/vault-sync/deadline.json"), "utf8");
    for (const text of [JSON.stringify(first), JSON.stringify(second), JSON.stringify(status), record]) {
      expect(text).not.toContain(FAKE_KEY);
      expect(text).not.toContain(FAKE_KEY_2);
      expect(text).not.toContain("aws_access_key_id");
    }
    expect(git(sb.dir, ["--git-dir", sb.remote, "for-each-ref"]).toString()).toBe("");
    expect(scanDirs()).toEqual(dirsBefore);
  }, 60_000);

  test.skipIf(!hasGitleaks)("clean content passes the default scanner", async () => {
    const sb = sandbox();
    sandboxes.push(sb);
    const e = engine();
    await e.enable(sb.repo);
    put(sb.repo, "notes/plain.md", "a chapter draft\n");
    await e.capture(sb.repo, { include: ["notes"] });
    expect((await e.pushBackup(sb.repo)).state).toBe("pushed");
  }, 60_000);
});
