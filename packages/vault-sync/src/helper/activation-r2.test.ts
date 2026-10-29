/**
 * Activation repair r2 (review-writeflex-backup-activation-r1, R6-R8): repository-scoped credentials for
 * the visibility check and the push, a body cap that stops reading, and one trust check over a program,
 * its credential helper and every folder above them.
 *
 * MOCKS, labelled: GitHub answers are synthetic Response objects (no network). Credentials come only from
 * a SYNTHETIC credential helper script written into the test folder that answers per repository path; no
 * real credential helper, Keychain item or account is run or read. Git is real (isolated from the user's
 * global and system configuration).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitRunner } from "../git-process.ts";
import { parseHelperConfig } from "./config.ts";
import { gitCredentialSource, githubRemoteOf, githubVisibilityCheck, readCapped } from "./github-visibility.ts";
import { productionSharedOptions, productionVaultOptions, REPOSITORY_SCOPED_CREDENTIALS, resolveProductionConfig } from "./production.ts";
import { CredentialHelperRefusedError, trustedCredentialHelper, trustedExecutable } from "./tools.ts";

const GIT = ["/Library/Developer/CommandLineTools/usr/bin/git", "/Applications/Xcode.app/Contents/Developer/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"].find((p) => existsSync(p)) ?? "/usr/bin/git";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});
function scratch(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "vault-sync-r2-")));
  dirs.push(d);
  return d;
}

/** SYNTHETIC repository-scoped credential store: a different fake password per repository path, none host-wide. */
function repoScopedHelper(dir: string): { helper: string; log: string } {
  const helper = join(dir, "synthetic-helper");
  const log = join(dir, "asked.txt");
  writeFileSync(helper, `#!/bin/sh
body=$(cat)
printf '%s\\n--\\n' "$body" >> '${log}'
[ "$1" = get ] || exit 0
case "$body" in
*path=owner/notes.git*) printf 'username=fixture\\npassword=synthetic-notes-git\\n';;
*path=owner/notes*) printf 'username=fixture\\npassword=synthetic-notes\\n';;
*path=owner/other*) printf 'username=fixture\\npassword=synthetic-other\\n';;
esac
`, { mode: 0o700 });
  return { helper, log };
}

describe("R6 credentials are selected per repository, the same for the visibility check and the push", () => {
  test("the visibility check asks for the remote's own path and gets that repository's credential, not a host-wide one", async () => {
    const d = scratch();
    const { helper, log } = repoScopedHelper(d);
    const source = gitCredentialSource({ gitPath: GIT, helper });
    expect(await source({ path: "owner/notes" })).toBe("synthetic-notes");
    expect(await source({ path: "owner/other" })).toBe("synthetic-other");
    expect(await source({ path: "owner/missing" })).toBeNull();
    // A path that is not a validated repository path never reaches Git (no newline or extra field injection).
    expect(await source({ path: "owner/notes\nhost=evil.example" })).toBeNull();
    expect(readFileSync(log, "utf8")).not.toContain("evil.example");
    // Through the check: the address decides the path, as Git will for the push.
    let auth = "";
    const fetch = (async (_url: string, init: RequestInit) => {
      auth = String((init.headers as Record<string, string>).Authorization);
      return new Response(JSON.stringify({ full_name: "owner/notes", private: true }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    expect(await githubVisibilityCheck({ repository: "owner/notes", credential: source, fetch })("https://github.com/owner/notes.git")).toEqual({ visibility: "private" });
    expect(auth).toBe("Bearer synthetic-notes-git");
    expect(githubRemoteOf("https://github.com/owner/notes")).toEqual({ repository: "owner/notes", credentialPath: "owner/notes" });
    expect(githubRemoteOf("https://github.com/owner/notes/")).toBeNull();
  });

  test("the engine's Git (push context) asks the same helper for the same repository path", async () => {
    const d = scratch();
    const { helper, log } = repoScopedHelper(d);
    const config = await parseHelperConfig({ configVersion: 2, machineId: "m", tools: { git: GIT, gitleaks: GIT }, credentialHelper: helper, vaults: [{ id: "v", path: d, include: ["**/*.md"], github: { repository: "owner/notes" } }] });
    const options = productionVaultOptions(config, config.vaults[0]!, undefined, { fetch: (async () => new Response("{}", { status: 404 })) as never });
    expect(options.trustedCredentialHelpers).toEqual([helper]);
    expect(options.gitEnv).toEqual({ ...REPOSITORY_SCOPED_CREDENTIALS });
    expect(productionSharedOptions(config)!.gitEnv).toEqual({ ...REPOSITORY_SCOPED_CREDENTIALS });
    // The runner the engine pushes with, with exactly these options: Git's own credential request for the
    // push URL carries the repository path, so the repository's own credential is chosen.
    const isolation = { HOME: d, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    const runner = createGitRunner({ gitPath: GIT, hooksDir: "/dev/null", env: { ...options.gitEnv, ...isolation }, credentialHelpers: options.trustedCredentialHelpers });
    const out = await runner.ok(["credential", "fill"], { cwd: d, timeoutMs: 10_000, maxOutputBytes: 64 * 1024, input: Buffer.from("url=https://github.com/owner/notes.git\n\n") });
    expect(out.toString("utf8")).toContain("password=synthetic-notes-git");
    expect(readFileSync(log, "utf8")).toContain("path=owner/notes.git");
  });

  test("an unresolved helper name is never given to Git: no credential, visibility unknown", async () => {
    const d = scratch();
    const config = await parseHelperConfig({ configVersion: 2, machineId: "m", tools: { git: GIT, gitleaks: GIT }, credentialHelper: "osxkeychain", vaults: [{ id: "v", path: d, include: ["**/*.md"], github: { repository: "owner/notes" } }] });
    const options = productionVaultOptions(config, config.vaults[0]!);
    expect(options.trustedCredentialHelpers).toEqual([]);
    expect(await options.remoteVisibility!("https://github.com/owner/notes")).toBe("unknown");
  });
});

describe("R7 the response cap stops reading", () => {
  test("an endless chunked body is read only up to the cap, then cancelled", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) { pulls++; c.enqueue(new Uint8Array(64 * 1024).fill(32)); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const answer = await githubVisibilityCheck({ repository: "owner/notes", credential: async () => "synthetic", fetch: (async () => new Response(body, { status: 200 })) as never })("https://github.com/owner/notes");
    expect(answer).toEqual({ visibility: "unknown", reason: "unexpected-answer" });
    expect(pulls).toBeLessThanOrEqual(5);
    expect(cancelled).toBe(true);
  });

  test("an early status refusal cancels the unread body", async () => {
    for (const status of [301, 401, 403, 404, 500]) {
      let pulls = 0;
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({ pull(c) { pulls++; c.enqueue(new Uint8Array(1024)); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
      const answer = await githubVisibilityCheck({ repository: "owner/notes", credential: async () => "synthetic", fetch: (async () => new Response(body, { status })) as never })("https://github.com/owner/notes");
      expect(answer.visibility).toBe("unknown");
      await new Promise((r) => setTimeout(r, 1));
      expect(cancelled).toBe(true);
      expect(pulls).toBe(0);
    }
  });

  test("a body within the cap is read whole", async () => {
    const r = new Response(new Uint8Array(1000).fill(65));
    expect((await readCapped(r, 1000))!.byteLength).toBe(1000);
    expect(await readCapped(new Response(new Uint8Array(1001)), 1000)).toBeNull();
  });
});

describe("R8 one trust check over the program, the credential helper and every folder above them", () => {
  const program = (dir: string, mode = 0o755): string => {
    const file = join(dir, "tool");
    writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode });
    chmodSync(file, mode);
    return file;
  };

  test("a replaceable folder above the program is refused: others-writable without sticky, or writable by an ordinary group", async () => {
    const d = scratch();
    const open = join(d, "open"); mkdirSync(open); chmodSync(open, 0o777);
    await expect(trustedExecutable("git", program(open))).rejects.toThrow("writable by others");
    const grouped = join(d, "grouped"); mkdirSync(grouped); chmodSync(grouped, 0o775);
    // The user's primary group (staff on macOS) is not a privileged group.
    await expect(trustedExecutable("git", program(grouped))).rejects.toThrow("writable by its group");
    const fine = join(d, "fine"); mkdirSync(fine); chmodSync(fine, 0o755);
    expect(await trustedExecutable("git", program(fine))).toBe(join(fine, "tool"));
  });

  test("a user-owned folder under a sticky others-writable folder is accepted; the sticky rule is the only relaxation", async () => {
    const d = scratch();
    const sticky = join(d, "sticky"); mkdirSync(sticky);
    // Bun's chmodSync drops the sticky bit; the system chmod sets it.
    execFileSync("/bin/chmod", ["1777", sticky]);
    expect(statSync(sticky).mode & 0o1777).toBe(0o1777);
    const mine = join(sticky, "mine"); mkdirSync(mine); chmodSync(mine, 0o700);
    expect(await trustedExecutable("gitleaks", program(mine))).toBe(join(mine, "tool"));
    // The program itself directly in the sticky folder is still the user's own file: accepted; a group-writable one is not.
    expect(await trustedExecutable("gitleaks", program(sticky))).toBe(join(sticky, "tool"));
    chmodSync(join(sticky, "tool"), 0o775);
    await expect(trustedExecutable("gitleaks", join(sticky, "tool"))).rejects.toThrow("group or others");
  });

  test("an absolute credential helper gets the same check, and is never run when refused", async () => {
    const d = scratch();
    const ran = join(d, "ran");
    const helper = join(d, "helper");
    writeFileSync(helper, `#!/bin/sh\ntouch '${ran}'\n`, { mode: 0o777 });
    chmodSync(helper, 0o777);
    await expect(trustedCredentialHelper(GIT, helper)).rejects.toBeInstanceOf(CredentialHelperRefusedError);
    const open = join(d, "open"); mkdirSync(open); chmodSync(open, 0o777);
    const inOpen = join(open, "helper");
    writeFileSync(inOpen, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await expect(trustedCredentialHelper(GIT, inOpen)).rejects.toThrow("writable by others");
    chmodSync(helper, 0o700);
    expect(await trustedCredentialHelper(GIT, helper)).toBe(helper);
    expect(existsSync(ran)).toBe(false);
  });

  test("osxkeychain is resolved in the trusted Git's own exec path to an absolute checked path (resolved only, never run)", async () => {
    const resolved = await trustedCredentialHelper(GIT, "osxkeychain");
    expect(resolved.endsWith("/git-credential-osxkeychain")).toBe(true);
    expect(resolved.startsWith("/")).toBe(true);
  });

  test("resolveProductionConfig gives the run and the enrolment the checked real paths; a refused helper refuses the configuration", async () => {
    const d = scratch();
    const gitleaks = ["/opt/homebrew/bin/gitleaks", "/usr/local/bin/gitleaks"].find((p) => existsSync(p))!;
    const ok = await resolveProductionConfig(await parseHelperConfig({ configVersion: 2, machineId: "m", tools: { git: GIT, gitleaks }, credentialHelper: "osxkeychain", vaults: [{ id: "v", path: d, include: ["**/*.md"] }] }));
    expect(ok.tools!.gitleaks).toBe(realpathSync(gitleaks));
    expect(ok.credentialHelper!.endsWith("/git-credential-osxkeychain")).toBe(true);
    const bad = join(d, "bad"); writeFileSync(bad, "#!/bin/sh\n", { mode: 0o777 }); chmodSync(bad, 0o777);
    await expect(resolveProductionConfig(await parseHelperConfig({ configVersion: 2, machineId: "m", tools: { git: GIT, gitleaks }, credentialHelper: bad, vaults: [{ id: "v", path: d, include: ["**/*.md"] }] }))).rejects.toBeInstanceOf(CredentialHelperRefusedError);
    // Shell metacharacters never pass the configuration.
    await expect(parseHelperConfig({ configVersion: 2, machineId: "m", tools: { git: GIT, gitleaks }, credentialHelper: "/tmp/x;rm", vaults: [{ id: "v", path: d, include: ["**/*.md"] }] })).rejects.toThrow("credentialHelper");
  });
});
