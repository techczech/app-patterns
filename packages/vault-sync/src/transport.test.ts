import { setDefaultTimeout, afterEach, describe, expect, test } from "bun:test";
setDefaultTimeout(60_000);
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createBackupEngine, type BackupEngineOptions } from "./index.ts";
import { createGitRunner } from "./git-process.ts";
import { git, gitText, isolatedGitEnv, sandbox, type Sandbox } from "./test-fixtures.ts";

/**
 * Review round 2, R3/S1/S2: the destination validated at the start of an operation is the one it uses,
 * and repository configuration cannot redirect, widen or weaken the transport. Scan callbacks are used as
 * a deterministic point at which another program changes the repository's configuration.
 */

const sandboxes: Sandbox[] = [];
afterEach(() => {
  while (sandboxes.length) sandboxes.pop()!.cleanup();
});

function setup(): Sandbox {
  const sb = sandbox();
  sandboxes.push(sb);
  return sb;
}

function put(root: string, path: string, content: string): void {
  const abs = join(root, ...path.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function bare(sb: Sandbox, name: string): string {
  const path = join(sb.dir, name);
  git(sb.dir, ["init", "-q", "--bare", "-b", "main", path]);
  return path;
}

function refs(remote: string): string {
  return gitText(dirname(remote), ["--git-dir", remote, "for-each-ref", "--format=%(objectname) %(refname)"]);
}

function markerProgram(sb: Sandbox, name: string): { program: string; marker: string } {
  const marker = join(sb.dir, `${name}.ran`);
  const program = join(sb.dir, `${name}.sh`);
  writeFileSync(program, `#!/bin/sh\necho executed > '${marker}'\nexit 1\n`);
  chmodSync(program, 0o755);
  return { program, marker };
}

/** Destinations whose path contains "public" are public. `duringScan` runs inside the push's secret scan. */
function engine(sb: Sandbox, asked: string[], duringScan: () => void, overrides: Partial<BackupEngineOptions> = {}) {
  return createBackupEngine({
    machineId: "test-machine",
    settleMs: 0,
    gitEnv: isolatedGitEnv,
    homeDir: join(sb.dir, "home"),
    mountInfo: async () => null,
    remoteVisibility: async (url) => {
      asked.push(url);
      return url.includes("public") ? "public" : "private";
    },
    secretScanner: async () => {
      duringScan();
      return { findings: [] };
    },
    ...overrides,
  });
}

const posix = process.platform !== "win32";

describe("the validated destination is the one the push uses (review round 2, R3)", () => {
  test("changing the remote's address during the scan does not redirect the push", async () => {
    const sb = setup();
    const other = bare(sb, "public.git");
    put(sb.repo, "notes/a.md", "private draft\n");
    const asked: string[] = [];
    const e = engine(sb, asked, () => git(sb.repo, ["remote", "set-url", "origin", other]));
    await e.enable(sb.repo);
    await e.capture(sb.repo, { include: ["notes"] });
    const pushed = await e.pushBackup(sb.repo);
    expect(pushed.state).toBe("pushed");
    expect(refs(other)).toBe("");
    expect(refs(sb.remote)).toContain("refs/heads/backup/test-machine/");
    expect(asked.every((url) => url === sb.remote)).toBe(true);
    // The next operation sees the change and stops until backup is turned on again.
    expect(await e.pushBackup(sb.repo)).toMatchObject({ state: "blocked", reason: "enablement-stale" });
  });

  test("an address rewrite added during the scan does not redirect the push", async () => {
    const sb = setup();
    const other = bare(sb, "public.git");
    put(sb.repo, "notes/a.md", "private draft\n");
    const e = engine(sb, [], () => git(sb.repo, ["config", `url.${other}.insteadOf`, sb.remote]));
    await e.enable(sb.repo);
    await e.capture(sb.repo, { include: ["notes"] });
    expect((await e.pushBackup(sb.repo)).state).toBe("pushed");
    expect(refs(other)).toBe("");
    expect(refs(sb.remote)).toContain("refs/heads/backup/test-machine/");
  });

  test("an address rewrite in place at enable is what the visibility check sees", async () => {
    const sb = setup();
    const other = bare(sb, "public.git");
    git(sb.repo, ["config", `url.${other}.insteadOf`, sb.remote]);
    put(sb.repo, "notes/a.md", "private draft\n");
    const asked: string[] = [];
    const e = engine(sb, asked, () => undefined);
    await expect(e.enable(sb.repo)).rejects.toMatchObject({ reason: "public-remote-unconfirmed" });
    expect(asked).toEqual([other]);
  });
});

describe("repository configuration cannot widen the transports (review round 2, S1)", () => {
  test.if(posix)("a protocol-specific grant in the repository does not let the runner use another transport", async () => {
    const sb = setup();
    const { program, marker } = markerProgram(sb, "ext");
    git(sb.repo, ["config", "protocol.ext.allow", "always"]);
    const runner = createGitRunner({ hooksDir: join(sb.dir, "hooks"), env: isolatedGitEnv });
    const result = await runner.run(["ls-remote", `ext::${program}`], { cwd: sb.repo, timeoutMs: 10_000, maxOutputBytes: 1024 });
    expect(result.code).not.toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  test.if(posix)("a grant and a helper address set during the scan run nothing, and the push still goes to the validated destination", async () => {
    const sb = setup();
    const { program, marker } = markerProgram(sb, "ext-engine");
    put(sb.repo, "notes/a.md", "private draft\n");
    const e = engine(sb, [], () => {
      git(sb.repo, ["config", "protocol.ext.allow", "always"]);
      git(sb.repo, ["remote", "set-url", "origin", `ext::${program}`]);
    });
    await e.enable(sb.repo);
    await e.capture(sb.repo, { include: ["notes"] });
    expect((await e.pushBackup(sb.repo)).state).toBe("pushed");
    expect(existsSync(marker)).toBe(false);
    expect(refs(sb.remote)).toContain("refs/heads/backup/test-machine/");
  });
});

const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;

/** A localhost HTTPS Git server with a throwaway self-signed certificate and synthetic Basic credentials. */
function httpsFixture(sb: Sandbox) {
  const key = join(sb.dir, "key.pem");
  const cert = join(sb.dir, "cert.pem");
  const made = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "pipe" });
  if (made.status !== 0) throw new Error("could not make a test certificate");
  git(sb.dir, ["--git-dir", sb.remote, "config", "http.receivepack", "true"]);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { key: readFileSync(key), cert: readFileSync(cert) },
    async fetch(req: Request) {
      if (req.headers.get("authorization") !== `Basic ${btoa("fixture:fixture")}`) return new Response("credentials required", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="fixture"' } });
      const url = new URL(req.url);
      const body = Buffer.from(await req.arrayBuffer());
      const cgi = spawnSync("git", ["http-backend"], {
        env: { ...process.env, ...isolatedGitEnv, GIT_PROJECT_ROOT: sb.dir, GIT_HTTP_EXPORT_ALL: "1", PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers.get("content-type") ?? "", CONTENT_LENGTH: String(body.length), REMOTE_USER: "fixture" },
        input: body,
        maxBuffer: 16 * 1024 * 1024,
      });
      const split = cgi.stdout.indexOf("\r\n\r\n");
      if (split < 0) return new Response("backend failed", { status: 500 });
      const headers = new Headers();
      let status = 200;
      for (const line of cgi.stdout.subarray(0, split).toString().split("\r\n")) {
        const i = line.indexOf(":");
        if (i < 0) continue;
        const name = line.slice(0, i);
        const value = line.slice(i + 1).trim();
        if (name.toLowerCase() === "status") status = Number(value.split(" ")[0]);
        else headers.append(name, value);
      }
      return new Response(cgi.stdout.subarray(split + 4), { status, headers });
    },
  });
  return { cert, url: `https://127.0.0.1:${server.port}/remote.git`, stop: () => server.stop(true) };
}

const trustedHelper = ["!f() { echo username=fixture; echo password=fixture; }; f"];

describe("repository configuration cannot weaken HTTPS (review round 2, S2)", () => {
  test.if(posix && hasOpenssl)("repository TLS settings do not make an unauthenticated peer count; an app-trusted authority and helper do", async () => {
    const sb = setup();
    const https = httpsFixture(sb);
    try {
      git(sb.repo, ["remote", "set-url", "origin", https.url]);
      put(sb.repo, "notes/a.md", "synthetic HTTPS content\n");

      const untrusted = engine(sb, [], () => undefined, { trustedCredentialHelpers: trustedHelper });
      await untrusted.enable(sb.repo);
      await untrusted.capture(sb.repo, { include: ["notes"] });
      expect((await untrusted.pushBackup(sb.repo)).state).toBe("failed");
      git(sb.repo, ["config", "http.sslVerify", "false"]);
      git(sb.repo, ["config", `http.${https.url}.sslVerify`, "false"]);
      expect((await untrusted.pushBackup(sb.repo)).state).toBe("failed");
      expect((await untrusted.verify(sb.repo)).verified).toBe(false);
      await expect(untrusted.listBackups(sb.repo)).rejects.toThrow();
      expect(refs(sb.remote)).toBe("");

      // Credentials the repository supplies are not used either.
      const trusted = engine(sb, [], () => undefined, { gitEnv: { ...isolatedGitEnv, GIT_SSL_CAINFO: https.cert } });
      git(sb.repo, ["config", "credential.helper", trustedHelper[0]!]);
      expect((await trusted.pushBackup(sb.repo)).state).toBe("failed");

      const app = engine(sb, [], () => undefined, { gitEnv: { ...isolatedGitEnv, GIT_SSL_CAINFO: https.cert }, trustedCredentialHelpers: trustedHelper });
      const pushed = await app.pushBackup(sb.repo);
      expect(pushed.state).toBe("pushed");
      expect((await app.verify(sb.repo)).verified).toBe(true);
      const listed = await app.listBackups(sb.repo);
      expect(listed.map((b) => b.tip)).toEqual([pushed.state === "pushed" ? pushed.snapshot : ""]);
    } finally {
      https.stop();
    }
  });
});
