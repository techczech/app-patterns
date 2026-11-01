/**
 * Production configuration, trusted programs, GitHub identity and visibility, the credential lookup and the
 * one-shot enrolment commands.
 *
 * MOCKS, labelled: every GitHub API answer comes from `mockFetch` (no network), and every credential from
 * `mockCredential` or from a MOCK credential helper script written into the test folder that prints a fixed
 * fake token. No real credential, keychain item, account or network is used. Git, gitleaks and the fixture
 * repositories (local bare remotes) are real.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBackupEngine } from "../engine.ts";
import { git, sandbox, type Sandbox } from "../test-fixtures.ts";
import { parseHelperConfig, type HelperConfig } from "./config.ts";
import { disableVault, enableVault, previewVault } from "./enrol.ts";
import { gitCredentialSource, githubRepositoryOf, githubVisibilityCheck, parseCredentialAnswer } from "./github-visibility.ts";
import { productionVaultOptions } from "./production.ts";
import { checkTool, parseGitleaksVersion, parseGitVersion, ToolRefusedError, trustedExecutable } from "./tools.ts";

const GIT = ["/Library/Developer/CommandLineTools/usr/bin/git", "/Applications/Xcode.app/Contents/Developer/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"].find((p) => existsSync(p)) ?? "/usr/bin/git";
const GITLEAKS = ["/opt/homebrew/bin/gitleaks", "/usr/local/bin/gitleaks"].find((p) => existsSync(p));
if (!GITLEAKS) throw new Error("these tests need a real gitleaks 8 at /opt/homebrew/bin or /usr/local/bin");

const boxes: Sandbox[] = [];
afterEach(() => {
  while (boxes.length) boxes.pop()!.cleanup();
});

function box(): Sandbox {
  const b = sandbox();
  boxes.push(b);
  mkdirSync(join(b.repo, "notes"), { recursive: true });
  mkdirSync(join(b.repo, ".writeflex", "outbox"), { recursive: true });
  writeFileSync(join(b.repo, "notes", "a.md"), "# A\n");
  writeFileSync(join(b.repo, "notes", "b.md"), "# B\n");
  writeFileSync(join(b.repo, ".writeflex", "versions.jsonl"), "{}\n");
  writeFileSync(join(b.repo, ".writeflex", "outbox", "x.md"), "outgoing\n");
  return b;
}

const v2 = (path: string, extra: Record<string, unknown> = {}, vault: Record<string, unknown> = {}) => ({
  configVersion: 2,
  machineId: "test-mac",
  tools: { git: GIT, gitleaks: GITLEAKS },
  credentialHelper: "osxkeychain",
  vaults: [{ id: "v", path, include: ["**/*.md", ".writeflex/versions.jsonl"], exclude: [".writeflex/outbox"], ...vault }],
  ...extra,
});

/** MOCK GitHub API: answers from a table, records each request. */
function mockFetch(answer: (url: string) => { status: number; body?: unknown; headers?: Record<string, string> } | "throw") {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const a = answer(url);
    if (a === "throw") throw new TypeError("mock network failure");
    return new Response(a.body === undefined ? "" : JSON.stringify(a.body), { status: a.status, headers: a.headers ?? {} });
  }) as typeof fetch;
  return { fn, calls };
}
const MOCK_TOKEN = "mock-token-not-a-secret";
const mockCredential = async (): Promise<string | null> => MOCK_TOKEN;
const repo = (full: string, priv: boolean, visibility?: string) => ({ status: 200, body: { full_name: full, private: priv, ...(visibility ? { visibility } : {}) } });

describe("production configuration (version 2)", () => {
  test("accepts trusted tools, a credential helper and a GitHub identity; version 1 refuses them", async () => {
    const b = box();
    const cfg = await parseHelperConfig(v2(b.repo, {}, { github: { repository: "owner/notes" } }));
    expect(cfg.tools).toEqual({ git: GIT, gitleaks: GITLEAKS! });
    expect(cfg.credentialHelper).toBe("osxkeychain");
    expect(cfg.vaults[0]!.github).toEqual({ repository: "owner/notes" });
    await expect(parseHelperConfig({ ...v2(b.repo), configVersion: 1 })).rejects.toThrow("unexpected field");
    await expect(parseHelperConfig({ configVersion: 1, machineId: "m", vaults: [{ id: "v", path: b.repo, include: ["notes"], github: { repository: "o/r" } }] })).rejects.toThrow("unexpected field");
  });

  test("refuses missing tools, relative tools, odd helpers and malformed repositories", async () => {
    const b = box();
    await expect(parseHelperConfig({ ...v2(b.repo), tools: undefined })).rejects.toThrow("tools");
    await expect(parseHelperConfig(v2(b.repo, { tools: { git: "git", gitleaks: GITLEAKS } }))).rejects.toThrow("absolute");
    await expect(parseHelperConfig(v2(b.repo, { tools: { git: GIT, gitleaks: GITLEAKS, shell: "/bin/sh" } }))).rejects.toThrow("unexpected field");
    await expect(parseHelperConfig(v2(b.repo, { credentialHelper: "store" }))).rejects.toThrow("credentialHelper");
    await expect(parseHelperConfig(v2(b.repo, { credentialHelper: "!sh -c evil" }))).rejects.toThrow("credentialHelper");
    await expect(parseHelperConfig(v2(b.repo, {}, { github: { repository: "owner" } }))).rejects.toThrow("owner/name");
    await expect(parseHelperConfig(v2(b.repo, {}, { github: { repository: "owner/notes.git" } }))).rejects.toThrow("owner/name");
    await expect(parseHelperConfig(v2(b.repo, {}, { github: { repository: "owner/..", extra: 1 } }))).rejects.toThrow();
  });
});

describe("trusted programs", () => {
  test("the real git and gitleaks are trusted, with their versions", async () => {
    const g = await checkTool("git", GIT);
    expect(g.version).toMatch(/^2\.\d+\.\d+$/);
    const l = await checkTool("gitleaks", GITLEAKS!);
    expect(l.version).toMatch(/^8\.\d+\.\d+$/);
  });

  test("refuses missing, non-executable, group-writable and wrong-version programs", async () => {
    const b = box();
    await expect(trustedExecutable("git", join(b.dir, "missing"))).rejects.toThrow("not found");
    const plain = join(b.dir, "plain");
    writeFileSync(plain, "#!/bin/sh\n");
    chmodSync(plain, 0o644);
    await expect(trustedExecutable("git", plain)).rejects.toThrow("not executable");
    chmodSync(plain, 0o775);
    await expect(trustedExecutable("git", plain)).rejects.toThrow("group or others");
    const fake = join(b.dir, "fake-git");
    writeFileSync(fake, "#!/bin/sh\necho 'git version 1.9.0'\n");
    chmodSync(fake, 0o755);
    await expect(checkTool("git", fake)).rejects.toBeInstanceOf(ToolRefusedError);
    await expect(checkTool("git", fake)).rejects.toThrow("unsupported version");
    expect(parseGitVersion("git version 2.50.1 (Apple Git-155)")).toBe("2.50.1");
    expect(parseGitVersion("git version 2.37.0")).toBeNull();
    expect(parseGitleaksVersion("8.30.1\n")).toBe("8.30.1");
    expect(parseGitleaksVersion("9.0.0")).toBeNull();
  });
});

describe("GitHub repository identity", () => {
  test("only a plain https://github.com/<owner>/<name> address is a GitHub remote", () => {
    expect(githubRepositoryOf("https://github.com/owner/notes.git")).toBe("owner/notes");
    expect(githubRepositoryOf("https://github.com/owner/notes")).toBe("owner/notes");
    for (const url of [
      "https://user:pw@github.com/owner/notes.git",
      "https://token@github.com/owner/notes.git",
      "https://github.com:443/owner/notes.git",
      "https://www.github.com/owner/notes.git",
      "https://github.example.com/owner/notes.git",
      "https://github.com/owner/notes.git?x=1",
      "https://github.com/owner/notes.git#x",
      "https://github.com/owner/notes/extra",
      "http://github.com/owner/notes.git",
      "git@github.com:owner/notes.git",
      "https://github.com.evil.example/owner/notes",
      "/local/path",
    ]) expect(githubRepositoryOf(url)).toBeNull();
  });
});

describe("GitHub visibility (MOCK API, MOCK credential)", () => {
  const url = "https://github.com/owner/notes.git";
  const check = (fetchFn: typeof fetch, credential = mockCredential) => githubVisibilityCheck({ repository: "owner/notes", credential, fetch: fetchFn })(url);

  test("private, internal and public answers; the request is bounded and not redirected", async () => {
    const m = mockFetch(() => repo("Owner/Notes", true, "private"));
    expect(await check(m.fn)).toEqual({ visibility: "private" });
    expect(m.calls[0]!.url).toBe("https://api.github.com/repos/owner/notes");
    expect(m.calls[0]!.init.redirect).toBe("manual");
    expect(m.calls[0]!.init.signal).toBeDefined();
    expect((m.calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${MOCK_TOKEN}`);
    expect(await check(mockFetch(() => repo("owner/notes", true, "internal")).fn)).toEqual({ visibility: "private" });
    expect(await check(mockFetch(() => repo("owner/notes", false, "public")).fn)).toEqual({ visibility: "public" });
  });

  test("every doubt is unknown with a reason, and no call is made without a credential", async () => {
    const cases: Array<[Parameters<typeof mockFetch>[0], string]> = [
      [() => ({ status: 301, headers: { location: "https://api.github.com/repositories/1" } }), "redirected"],
      [() => ({ status: 401 }), "denied"],
      [() => ({ status: 403 }), "denied"],
      [() => ({ status: 403, headers: { "x-ratelimit-remaining": "0" } }), "rate-limited"],
      [() => ({ status: 404 }), "not-found"],
      [() => ({ status: 500 }), "http-error"],
      [() => "throw", "network"],
      [() => repo("someone/else", true), "unexpected-answer"],
      [() => repo("owner/notes", true, "public"), "unexpected-answer"],
      [() => ({ status: 200, body: { full_name: "owner/notes" } }), "unexpected-answer"],
      [() => ({ status: 200, body: { full_name: "owner/notes", private: true }, headers: { "content-length": String(10 * 1024 * 1024) } }), "unexpected-answer"],
    ];
    for (const [answer, reason] of cases) expect(await check(mockFetch(answer).fn)).toEqual({ visibility: "unknown", reason } as never);
    const none = mockFetch(() => repo("owner/notes", true));
    expect(await check(none.fn, async () => null)).toEqual({ visibility: "unknown", reason: "no-credential" });
    expect(await check(none.fn, async () => { throw new Error("keychain locked"); })).toEqual({ visibility: "unknown", reason: "no-credential" });
    expect(none.calls).toHaveLength(0);
    const other = mockFetch(() => repo("owner/notes", true));
    expect(await githubVisibilityCheck({ repository: "owner/other", credential: mockCredential, fetch: other.fn })(url)).toEqual({ visibility: "unknown", reason: "other-repository" });
    expect(await githubVisibilityCheck({ repository: "owner/notes", credential: mockCredential, fetch: other.fn })("https://x@github.com/owner/notes")).toEqual({ visibility: "unknown", reason: "not-github-address" });
    expect(other.calls).toHaveLength(0);
  });
});

describe("credential lookup through Git's credential protocol (MOCK helper script)", () => {
  test("returns only the trusted helper's github.com password and clears every other source", async () => {
    const b = box();
    const helper = join(b.dir, "mock-credential-helper");
    const log = join(b.dir, "helper-input.txt");
    // MOCK: prints a fixed fake token for `get` and records what Git asked.
    writeFileSync(helper, `#!/bin/sh\ncat > '${log}'\nif [ "$1" = get ]; then echo username=x-access-token; echo password=${MOCK_TOKEN}; fi\n`);
    chmodSync(helper, 0o700);
    const token = await gitCredentialSource({ gitPath: GIT, helper })({ path: "owner/notes" });
    expect(token).toBe(MOCK_TOKEN);
    expect(readFileSync(log, "utf8")).toContain("host=github.com");
    expect(readFileSync(log, "utf8")).toContain("path=owner/notes");
    const failing = join(b.dir, "mock-failing-helper");
    writeFileSync(failing, "#!/bin/sh\nexit 0\n");
    chmodSync(failing, 0o700);
    expect(await gitCredentialSource({ gitPath: GIT, helper: failing, timeoutMs: 5_000 })({ path: "owner/notes" })).toBeNull();
    expect(await gitCredentialSource({ gitPath: join(b.dir, "no-git"), helper })({ path: "owner/notes" })).toBeNull();
    expect(parseCredentialAnswer("protocol=https\nhost=github.com\npassword=x\n")?.get("password")).toBe("x");
    expect(parseCredentialAnswer("garbage")).toBeNull();
  });
});

async function config(b: Sandbox, vault: Record<string, unknown> = {}): Promise<HelperConfig> {
  return parseHelperConfig(v2(b.repo, {}, vault));
}
const quiet = { mountInfo: async () => null, homeDir: "/nonexistent-test-home" };

describe("enrolment commands", () => {
  test("preview lists exact paths, excludes, publication and a local remote as private; enable and disable keep debt", async () => {
    const b = box();
    const cfg = await config(b);
    const p = await previewVault(cfg, "v", quiet);
    expect(p.refused).toBeNull();
    expect(p.remote).toEqual({ kind: "local", path: b.remote });
    expect(p.visibility).toBe("private");
    expect(p.files.items).toEqual([".writeflex/versions.jsonl", "notes/a.md", "notes/b.md"]);
    expect(p.publication).toEqual({ branchPrefix: "backup/test-mac/", userCommitsSent: false, block: null });
    expect(JSON.stringify(p)).not.toContain("# A");
    expect(p.enabled).toBe(false);
    expect(await enableVault(cfg, "v", { confirmPublic: false }, quiet)).toEqual({ enabled: true, root: b.repo, visibility: "private" });
    expect((await previewVault(cfg, "v", quiet)).enabled).toBe(true);
    await disableVault(cfg, "v", quiet);
    expect((await previewVault(cfg, "v", quiet)).enabled).toBe(false);
    // The engine folder (record, receipts, debt) is kept.
    expect(existsSync(join(b.repo, ".git", "vault-sync"))).toBe(true);
  });

  test("refuses a subfolder, a cloud folder and a network drive", async () => {
    const b = box();
    const sub = await parseHelperConfig(v2(join(b.repo, "notes")));
    expect((await previewVault(sub, "v", quiet)).refused).toContain("top folder");
    expect((await enableVault(sub, "v", { confirmPublic: false }, quiet)).enabled).toBe(false);
    const cfg = await config(b);
    // A home whose Library/CloudStorage holds the vault: make that layout and point the vault there.
    const home = join(b.dir, "home");
    const inCloud = join(home, "Library", "CloudStorage", "OneDrive-Personal", "vault");
    mkdirSync(join(inCloud, ".."), { recursive: true });
    git(b.dir, ["clone", "-q", b.remote, inCloud]);
    const cloudCfg = await parseHelperConfig(v2(inCloud));
    expect((await previewVault(cloudCfg, "v", { mountInfo: async () => null, homeDir: home })).refused).toContain("cloud-synced");
    expect((await enableVault(cloudCfg, "v", { confirmPublic: false }, { mountInfo: async () => null, homeDir: home })).enabled).toBe(false);
    const network = await previewVault(cfg, "v", { homeDir: "/nonexistent-test-home", mountInfo: async () => ({ device: "//server/share", mountPoint: "/", type: "smbfs", local: false }) });
    expect(network.refused).toContain("network drive");
  });

  test("GitHub remote: private enables, public needs confirmation, auth failure and unknown refuse (MOCK API)", async () => {
    const b = box();
    git(b.repo, ["remote", "set-url", "origin", "https://github.com/owner/notes.git"]);
    const cfg = await config(b, { github: { repository: "owner/notes" } });
    let answer = repo("owner/notes", true, "private");
    const api = mockFetch(() => answer);
    const deps = { ...quiet, fetch: api.fn, credential: mockCredential };
    const p = await previewVault(cfg, "v", deps);
    expect(p.remote).toEqual({ kind: "github", repository: "owner/notes" });
    expect(p.visibility).toBe("private");
    expect(JSON.stringify(p)).not.toContain(MOCK_TOKEN);
    expect(await enableVault(cfg, "v", { confirmPublic: false }, deps)).toEqual({ enabled: true, root: b.repo, visibility: "private" });
    await disableVault(cfg, "v", deps);
    answer = repo("owner/notes", false, "public");
    expect(await enableVault(cfg, "v", { confirmPublic: false }, deps)).toEqual({ enabled: false, reason: "the repository is public; confirm publication to a public repository first" });
    expect(await enableVault(cfg, "v", { confirmPublic: true }, deps)).toEqual({ enabled: true, root: b.repo, visibility: "public" });
    await disableVault(cfg, "v", deps);
    expect(await enableVault(cfg, "v", { confirmPublic: false }, { ...deps, credential: async () => null })).toEqual({ enabled: false, reason: "whether the repository is private could not be checked (no-credential)" });
    answer = { status: 404 } as never;
    expect((await enableVault(cfg, "v", { confirmPublic: false }, deps)).enabled).toBe(false);
    const wrong = await config(b, { github: { repository: "owner/other" } });
    answer = repo("owner/notes", true);
    expect((await enableVault(wrong, "v", { confirmPublic: false }, deps)).enabled).toBe(false);
  });

  test("a repository made public after enabling holds the next push (MOCK API, real engine and gitleaks)", async () => {
    const b = box();
    git(b.repo, ["remote", "set-url", "origin", "https://github.com/owner/notes.git"]);
    const cfg = await config(b, { github: { repository: "owner/notes" } });
    let answer = repo("owner/notes", true, "private");
    const api = mockFetch(() => answer);
    const deps = { ...quiet, fetch: api.fn, credential: mockCredential };
    expect((await enableVault(cfg, "v", { confirmPublic: false }, deps)).enabled).toBe(true);
    const engine = createBackupEngine({ machineId: "test-mac", ...productionVaultOptions(cfg, cfg.vaults[0]!, undefined, deps), ...quiet });
    await engine.capture(b.repo, cfg.vaults[0]!.scope);
    answer = repo("owner/notes", false, "public");
    const push = await engine.pushBackup(b.repo);
    expect(push).toMatchObject({ state: "blocked", reason: "public-remote-unconfirmed" });
    answer = { status: 401 } as never;
    expect(await engine.pushBackup(b.repo)).toMatchObject({ state: "blocked", reason: "visibility-unknown" });
  });
});
