import { setDefaultTimeout, afterEach, describe, expect, test } from "bun:test";
setDefaultTimeout(30_000);
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createBackupEngine, BackupRefusedError, urlDigest, type BackupEngineOptions, type CaptureProjection, type ProjectionRead } from "./index.ts";
import { git, gitText, isolatedGitEnv, permissiveGuards, sandbox, type Sandbox } from "./test-fixtures.ts";
import { checkedNamespaces, plainGitPath } from "./projection.ts";

const sandboxes: Sandbox[] = [];
afterEach(() => { while (sandboxes.length) sandboxes.pop()!.cleanup(); });
const setup = () => { const sb = sandbox(); sandboxes.push(sb); return sb; };
const SCOPE = { include: ["**/*.md"], exclude: [".meta"] };
const NS = [".meta/records.jsonl", ".meta/objects/"];

function put(root: string, path: string, content: string | Buffer): void {
  const abs = join(root, ...path.split("/"));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** A projection that answers whatever `next` holds; each answer's files exist in the worktree. */
function scripted(root: string) {
  const state: { next: ProjectionRead; reads: number } = { next: { state: "complete", files: [] }, reads: 0 };
  const projection: CaptureProjection = {
    name: "test-history",
    namespaces: NS,
    async read(r) {
      expect(r).toBe(root);
      state.reads++;
      return state.next;
    },
  };
  const complete = (files: Record<string, string>): ProjectionRead => {
    for (const [path, content] of Object.entries(files)) put(root, path, content);
    return { state: "complete", files: Object.entries(files).map(([path, content]) => ({ path, content: Buffer.from(content) })) };
  };
  return { state, projection, complete };
}

function engine(sb: Sandbox, overrides: Partial<BackupEngineOptions> = {}) {
  return createBackupEngine({ machineId: "test-machine", settleMs: 5, gitEnv: isolatedGitEnv, ...permissiveGuards, ...overrides });
}

function tree(repo: string, rev: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const record of git(repo, ["ls-tree", "-r", "-z", rev]).toString("utf8").split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    out.set(record.slice(tab + 1), git(repo, ["cat-file", "blob", record.slice(0, tab).split(" ")[2]!]).toString("utf8"));
  }
  return out;
}

describe("capture projection", () => {
  test("no projection: captures exactly the ordinary scope (default behaviour unchanged)", async () => {
    const sb = setup();
    put(sb.repo, "a.md", "A\n");
    put(sb.repo, ".meta/records.jsonl", "live\n");
    const e = engine(sb);
    await e.enable(sb.repo);
    const result = await e.capture(sb.repo, SCOPE);
    expect(result.projected).toBeUndefined();
    expect([...tree(sb.repo, result.snapshot!).keys()]).toEqual(["a.md"]);
  });

  test("a complete cohort enters the snapshot as one unit, never as editor reads", async () => {
    const sb = setup();
    put(sb.repo, "a.md", "A\n");
    const p = scripted(sb.repo);
    p.state.next = p.complete({ ".meta/records.jsonl": "r1\n", ".meta/objects/x": "object x\n" });
    const e = engine(sb, { historyProjection: p.projection });
    await e.enable(sb.repo);
    const result = await e.capture(sb.repo, SCOPE);
    expect(Object.fromEntries(tree(sb.repo, result.snapshot!))).toEqual({ "a.md": "A\n", ".meta/records.jsonl": "r1\n", ".meta/objects/x": "object x\n" });
    expect(result.added).toEqual(["a.md"]);
    expect(result.projected).toEqual({ files: 2, bytes: 12, added: [".meta/records.jsonl", ".meta/objects/x"], modified: [], removed: [] });
    // The deadline record's read map names the ordinary file only.
    const record = JSON.parse(readFileSync(join(sb.repo, ".git", "vault-sync", "deadline.json"), "utf8"));
    expect(JSON.stringify(record)).not.toContain(".meta/");
  });

  test("a later complete cohort removes what it no longer holds; earlier snapshots keep it", async () => {
    const sb = setup();
    put(sb.repo, "a.md", "A\n");
    const p = scripted(sb.repo);
    p.state.next = p.complete({ ".meta/records.jsonl": "r1\n", ".meta/objects/x": "x\n" });
    const e = engine(sb, { historyProjection: p.projection });
    await e.enable(sb.repo);
    const first = await e.capture(sb.repo, SCOPE);
    p.state.next = p.complete({ ".meta/records.jsonl": "r2\n" });
    const second = await e.capture(sb.repo, SCOPE);
    expect(second.projected).toMatchObject({ modified: [".meta/records.jsonl"], removed: [".meta/objects/x"] });
    expect(Object.fromEntries(tree(sb.repo, second.snapshot!))).toEqual({ "a.md": "A\n", ".meta/records.jsonl": "r2\n" });
    expect(tree(sb.repo, first.snapshot!).get(".meta/objects/x")).toBe("x\n");
    expect(gitText(sb.repo, ["rev-parse", `${second.snapshot}^`])).toBe(first.snapshot!);
    // A complete empty cohort is an answer: it removes the rest.
    p.state.next = { state: "complete", files: [] };
    const third = await e.capture(sb.repo, SCOPE);
    expect([...tree(sb.repo, third.snapshot!).keys()]).toEqual(["a.md"]);
  });

  test("unavailable holds the whole capture back: previous snapshot and cohort unchanged, block recorded", async () => {
    const sb = setup();
    put(sb.repo, "a.md", "A\n");
    const p = scripted(sb.repo);
    p.state.next = p.complete({ ".meta/records.jsonl": "r1\n" });
    const e = engine(sb, { historyProjection: p.projection });
    await e.enable(sb.repo);
    const first = await e.capture(sb.repo, SCOPE);
    put(sb.repo, "a.md", "A changed\n");
    p.state.next = { state: "unavailable", reason: "an object is missing" };
    const error = await e.capture(sb.repo, SCOPE).catch((x) => x);
    expect(error).toBeInstanceOf(BackupRefusedError);
    expect(error.reason).toBe("history-unavailable");
    const status = await e.status(sb.repo);
    expect(status.latestSnapshot).toBe(first.snapshot);
    expect(status.block?.reason).toBe("history-unavailable");
    // A first capture whose cohort is unavailable makes no snapshot at all.
    const sb2 = setup();
    put(sb2.repo, "a.md", "A\n");
    const p2 = scripted(sb2.repo);
    p2.state.next = { state: "unavailable", reason: "damaged" };
    const e2 = engine(sb2, { historyProjection: p2.projection });
    await e2.enable(sb2.repo);
    expect((await e2.capture(sb2.repo, SCOPE).catch((x) => x)).reason).toBe("history-unavailable");
    expect((await e2.status(sb2.repo)).latestSnapshot).toBeNull();
  });

  test("a projection that throws is unavailable, never a documents-only capture", async () => {
    const sb = setup();
    put(sb.repo, "a.md", "A\n");
    const e = engine(sb, { historyProjection: { name: "t", namespaces: NS, read: async () => { throw new Error("boom"); } } });
    await e.enable(sb.repo);
    expect((await e.capture(sb.repo, SCOPE).catch((x) => x)).reason).toBe("history-unavailable");
    expect((await e.status(sb.repo)).latestSnapshot).toBeNull();
  });

  const refusals: Array<[string, (root: string) => ProjectionRead]> = [
    ["traversal", () => ({ state: "complete", files: [{ path: ".meta/objects/../../a.md", content: Buffer.from("x") }] })],
    ["outside its namespaces", (r) => { put(r, ".meta/other", "x"); return { state: "complete", files: [{ path: ".meta/other", content: Buffer.from("x") }] }; }],
    ["duplicate", (r) => { put(r, ".meta/records.jsonl", "x"); return { state: "complete", files: [{ path: ".meta/records.jsonl", content: Buffer.from("x") }, { path: ".meta/records.jsonl", content: Buffer.from("y") }] }; }],
    ["absolute", () => ({ state: "complete", files: [{ path: "/etc/passwd", content: Buffer.from("x") }] })],
    [".git part", () => ({ state: "complete", files: [{ path: ".meta/objects/.git", content: Buffer.from("x") }] })],
    ["not bytes", (r) => { put(r, ".meta/records.jsonl", "x"); return { state: "complete", files: [{ path: ".meta/records.jsonl", content: "x" as unknown as Buffer }] }; }],
    ["missing in the worktree", () => ({ state: "complete", files: [{ path: ".meta/objects/gone", content: Buffer.from("x") }] })],
    ["beyond a symlink", (r) => { mkdirSync(join(r, "..", "outside"), { recursive: true }); writeFileSync(join(r, "..", "outside", "y"), "y"); mkdirSync(join(r, ".meta"), { recursive: true }); symlinkSync(join(r, "..", "outside"), join(r, ".meta", "objects")); return { state: "complete", files: [{ path: ".meta/objects/y", content: Buffer.from("y") }] }; }],
    ["oversized", (r) => { put(r, ".meta/records.jsonl", "x".repeat(2048)); return { state: "complete", files: [{ path: ".meta/records.jsonl", content: Buffer.from("x".repeat(2048)) }] }; }],
  ];
  for (const [name, answer] of refusals) {
    test(`refuses a cohort with a path ${name}; nothing is captured`, async () => {
      const sb = setup();
      put(sb.repo, "a.md", "A\n");
      const read = answer(sb.repo);
      const e = engine(sb, { maxFileBytes: 1024, historyProjection: { name: "t", namespaces: NS, read: async () => read } });
      await e.enable(sb.repo);
      const error = await e.capture(sb.repo, SCOPE).catch((x) => x);
      expect(error).toBeInstanceOf(BackupRefusedError);
      expect(error.reason).toBe("history-unavailable");
      expect((await e.status(sb.repo)).latestSnapshot).toBeNull();
    });
  }

  test("a namespace the ordinary scope also captures is refused (no collision with documents)", async () => {
    const sb = setup();
    put(sb.repo, "notes/x.md", "doc\n");
    const e = engine(sb, { historyProjection: { name: "t", namespaces: ["notes/"], read: async () => ({ state: "complete", files: [] }) } });
    await e.enable(sb.repo);
    expect((await e.capture(sb.repo, { include: ["**/*.md"] }).catch((x) => x)).reason).toBe("history-unavailable");
    put(sb.repo, "meta.md", "m\n");
    const e2 = engine(sb, { historyProjection: { name: "t", namespaces: ["meta.md"], read: async () => ({ state: "complete", files: [{ path: "meta.md", content: Buffer.from("m\n") }] }) } });
    expect((await e2.capture(sb.repo, { include: ["*.md"], exclude: ["notes"] }).catch((x) => x)).reason).toBe("history-unavailable");
  });

  test("projected bytes are pushed with the snapshot and go through the secret scan", async () => {
    const sb = setup();
    put(sb.repo, "a.md", "A\n");
    const p = scripted(sb.repo);
    p.state.next = p.complete({ ".meta/records.jsonl": "TOKEN=abc\n" });
    const scanned: string[] = [];
    const e = engine(sb, { historyProjection: p.projection, secretScanner: async (blobs) => { for (const b of blobs) scanned.push(b.path); return { findings: blobs.filter((b) => b.bytes.toString("utf8").includes("TOKEN")).map((b) => ({ path: b.path, rule: "token" })) }; } });
    await e.enable(sb.repo);
    await e.capture(sb.repo, SCOPE);
    const pushed = await e.pushBackup(sb.repo);
    expect(pushed.state).toBe("blocked");
    expect(pushed).toMatchObject({ reason: "secret-found" });
    expect(scanned).toContain(".meta/records.jsonl");
    expect(gitText(sb.remote, ["for-each-ref"])).toBe("");
  });

  test("capture never writes HEAD, the user's index or the worktree", async () => {
    const sb = setup();
    put(sb.repo, "a.md", "A\n");
    git(sb.repo, ["add", "a.md"]);
    git(sb.repo, ["-c", "user.name=t", "-c", "user.email=t@x.invalid", "commit", "-q", "-m", "user"]);
    const p = scripted(sb.repo);
    p.state.next = p.complete({ ".meta/records.jsonl": "r1\n" });
    const head = readFileSync(join(sb.repo, ".git", "HEAD"));
    const index = readFileSync(join(sb.repo, ".git", "index"));
    const live = readFileSync(join(sb.repo, ".meta", "records.jsonl"));
    const e = engine(sb, { historyProjection: p.projection });
    await e.enable(sb.repo);
    await e.capture(sb.repo, SCOPE);
    expect(readFileSync(join(sb.repo, ".git", "HEAD"))).toEqual(head);
    expect(readFileSync(join(sb.repo, ".git", "index"))).toEqual(index);
    expect(readFileSync(join(sb.repo, ".meta", "records.jsonl"))).toEqual(live);
    expect(gitText(sb.repo, ["status", "--porcelain", "--untracked-files=no"])).toBe("");
  });

  test("namespace declarations are checked", () => {
    expect(() => checkedNamespaces([])).toThrow();
    expect(() => checkedNamespaces(["../x"])).toThrow();
    expect(() => checkedNamespaces(["a/", "a/b"])).toThrow();
    expect(() => checkedNamespaces([".git/x"])).toThrow();
    expect(checkedNamespaces(["a/b.jsonl", "c/"])).toEqual(["a/b.jsonl", "c/"]);
    expect(plainGitPath("a\\b")).toBe(false);
  });
});

describe("enable compares the destination it pins with the one shown", () => {
  test("the digest of the shown address enables; another address is refused and pins nothing", async () => {
    const sb = setup();
    const e = engine(sb);
    const shown = urlDigest(sb.remote);
    const other = join(sb.dir, "other.git");
    git(sb.dir, ["init", "-q", "--bare", other]);
    git(sb.repo, ["remote", "set-url", "origin", other]);
    const error = await e.enable(sb.repo, { expectedDestinationDigest: shown }).catch((x) => x);
    expect(error).toBeInstanceOf(BackupRefusedError);
    expect(error.reason).toBe("enablement-stale");
    expect(existsSync(join(sb.repo, ".git", "vault-sync", "enablement.json"))).toBe(false);
    expect((await e.status(sb.repo)).enabled).toBe(false);
    git(sb.repo, ["remote", "set-url", "origin", sb.remote]);
    expect((await e.enable(sb.repo, { expectedDestinationDigest: shown })).realPath).toBe(sb.repo);
    expect((await e.status(sb.repo)).enabled).toBe(true);
  });

  test("a malformed digest is refused; no digest keeps the earlier behaviour", async () => {
    const sb = setup();
    const e = engine(sb);
    await expect(e.enable(sb.repo, { expectedDestinationDigest: "ABC" })).rejects.toThrow(/SHA-256/);
    expect((await e.enable(sb.repo)).realPath).toBe(sb.repo);
  });
});
