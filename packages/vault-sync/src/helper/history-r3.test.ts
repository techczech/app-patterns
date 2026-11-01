// r3: a vault that requires a history projection, and the destination shown at preview, through the
// helper's own commands. Real Git and gitleaks, a local bare remote; no network, no credential.
import { setDefaultTimeout, afterEach, describe, expect, test } from "bun:test";
setDefaultTimeout(30_000);
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, sandbox, type Sandbox } from "../test-fixtures.ts";
import { urlDigest } from "../enablement.ts";
import type { CaptureProjection, ProjectionRead } from "../projection.ts";
import { main } from "./cli.ts";
import { parseHelperConfig, type HelperConfig } from "./config.ts";
import { disableVault, enableVault, previewVault } from "./enrol.ts";
import { HistoryProjectionMissingError, productionVaultOptions, requiredProjection } from "./production.ts";

const GIT = ["/Library/Developer/CommandLineTools/usr/bin/git", "/Applications/Xcode.app/Contents/Developer/usr/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"].find((p) => existsSync(p)) ?? "/usr/bin/git";
const GITLEAKS = ["/opt/homebrew/bin/gitleaks", "/usr/local/bin/gitleaks"].find((p) => existsSync(p));
if (!GITLEAKS) throw new Error("these tests need a real gitleaks 8 at /opt/homebrew/bin or /usr/local/bin");
const quiet = { mountInfo: async () => null, homeDir: "/nonexistent-test-home" };

const boxes: Sandbox[] = [];
afterEach(() => { while (boxes.length) boxes.pop()!.cleanup(); });
function box(): Sandbox {
  const b = sandbox();
  boxes.push(b);
  mkdirSync(join(b.repo, "notes"), { recursive: true });
  writeFileSync(join(b.repo, "notes", "a.md"), "# A\n");
  mkdirSync(join(b.repo, ".hist"), { recursive: true });
  writeFileSync(join(b.repo, ".hist", "log.jsonl"), "one\n");
  return b;
}
const config = (b: Sandbox, history?: string): Promise<HelperConfig> => parseHelperConfig({
  configVersion: 2, machineId: "test-mac", tools: { git: GIT, gitleaks: GITLEAKS },
  vaults: [{ id: "v", path: b.repo, include: ["**/*.md"], exclude: [".hist"], remote: "origin", ...(history ? { history } : {}) }],
});
function projection(answer: () => ProjectionRead): CaptureProjection {
  return { name: "test-history", namespaces: [".hist/log.jsonl"], read: async () => answer() };
}
const complete = (): ProjectionRead => ({ state: "complete", files: [{ path: ".hist/log.jsonl", content: Buffer.from("one\n") }], summary: { namedVersions: 1 } });

describe("a vault that requires history", () => {
  test("configuration accepts only a capability name, never a path or command", async () => {
    const b = box();
    expect((await config(b, "test-history")).vaults[0]!.history).toBe("test-history");
    for (const bad of ["../x", "/abs/plugin.js", "Name", "a b", "x;rm"]) await expect(config(b, bad)).rejects.toThrow("history");
    await expect(parseHelperConfig({ configVersion: 1, machineId: "m", vaults: [{ id: "v", path: b.repo, include: ["**/*.md"], history: "test-history" }] })).rejects.toThrow("unexpected field");
  });

  test("the generic helper (no projections) refuses preview, enable and run; disable still works", async () => {
    const b = box();
    const cfg = await config(b, "test-history");
    const p = await previewVault(cfg, "v", quiet);
    expect(p.refused).toContain("test-history");
    expect(p.history).toBeNull();
    const e = await enableVault(cfg, "v", { confirmPublic: false }, quiet);
    expect(e.enabled).toBe(false);
    expect(existsSync(join(b.repo, ".git", "vault-sync", "enablement.json"))).toBe(false);
    expect(() => requiredProjection(cfg.vaults[0]!, undefined)).toThrow(HistoryProjectionMissingError);
    expect(() => productionVaultOptions(cfg, cfg.vaults[0]!)).toThrow(HistoryProjectionMissingError);
    // A projection of another name does not stand in for it.
    expect(() => requiredProjection(cfg.vaults[0]!, { other: () => projection(complete) })).toThrow(HistoryProjectionMissingError);
    expect(await disableVault(cfg, "v", quiet)).toEqual({ disabled: true });
  });

  test("`run` with a history vault and no projection fails before anything starts", async () => {
    const b = box();
    const file = join(b.dir, "config.json");
    writeFileSync(file, JSON.stringify({ configVersion: 2, machineId: "test-mac", tools: { git: GIT, gitleaks: GITLEAKS }, vaults: [{ id: "v", path: b.repo, include: ["**/*.md"], history: "test-history" }] }), { mode: 0o600 });
    const run = join(b.dir, "run");
    mkdirSync(run, { mode: 0o700 });
    await expect(main(["run", "--config", file, "--runtime-dir", run, "--max-runtime-ms", "60000"])).rejects.toBeInstanceOf(HistoryProjectionMissingError);
    expect(existsSync(join(run, "helper.sock"))).toBe(false);
  });

  test("preview reports the projected cohort exactly, as capture checks it; unavailable blocks enable", async () => {
    const b = box();
    const cfg = await config(b, "test-history");
    let answer = complete;
    const deps = { ...quiet, projections: { "test-history": () => projection(() => answer()) } };
    const p = await previewVault(cfg, "v", deps);
    expect(p.refused).toBeNull();
    expect(p.history).toEqual({ name: "test-history", state: "complete", files: 1, bytes: 4, items: [".hist/log.jsonl"], omitted: 0, summary: { namedVersions: 1 } });
    expect(p.files.items).toEqual(["notes/a.md"]);
    answer = () => ({ state: "complete", files: [{ path: ".hist/other", content: Buffer.from("x") }] });
    expect((await previewVault(cfg, "v", deps)).history).toMatchObject({ state: "unavailable", reason: expect.stringContaining("outside its namespaces") });
    answer = () => ({ state: "unavailable", reason: "an object is missing" });
    const refused = await enableVault(cfg, "v", { confirmPublic: false }, deps);
    expect(refused).toEqual({ enabled: false, reason: "the history this vault requires is not available (an object is missing)" });
    expect(existsSync(join(b.repo, ".git", "vault-sync", "enablement.json"))).toBe(false);
    // A complete empty projection is not unavailable: it enables.
    answer = () => ({ state: "complete", files: [] });
    expect((await previewVault(cfg, "v", deps)).history).toMatchObject({ state: "complete", files: 0, bytes: 0 });
    expect((await enableVault(cfg, "v", { confirmPublic: false }, deps)).enabled).toBe(true);
  });
});

describe("the destination shown is the destination pinned", () => {
  test("preview reports the digest of the validated address; enable with it pins that address only", async () => {
    const b = box();
    const cfg = await config(b);
    const p = await previewVault(cfg, "v", quiet);
    expect(p.destinationDigest).toBe(urlDigest(b.remote));
    expect(JSON.stringify(p)).not.toContain(urlDigest(join(b.dir, "second.git")));
    const second = join(b.dir, "second.git");
    git(b.dir, ["init", "-q", "--bare", second]);
    // The address changes after it was shown, before the actual enable.
    git(b.repo, ["remote", "set-url", "origin", second]);
    const refused = await enableVault(cfg, "v", { confirmPublic: false, expectedDestinationDigest: p.destinationDigest! }, quiet);
    expect(refused.enabled).toBe(false);
    expect(existsSync(join(b.repo, ".git", "vault-sync", "enablement.json"))).toBe(false);
    git(b.repo, ["remote", "set-url", "origin", b.remote]);
    expect((await enableVault(cfg, "v", { confirmPublic: false, expectedDestinationDigest: p.destinationDigest! }, quiet)).enabled).toBe(true);
    expect((await enableVault(cfg, "v", { confirmPublic: false, expectedDestinationDigest: "nothex" }, quiet))).toEqual({ enabled: false, reason: "the shown destination is not a destination digest" });
  });

  test("the command line passes --expected-destination through", async () => {
    const b = box();
    const file = join(b.dir, "config.json");
    writeFileSync(file, JSON.stringify({ configVersion: 2, machineId: "test-mac", tools: { git: GIT, gitleaks: GITLEAKS }, vaults: [{ id: "v", path: b.repo, include: ["**/*.md"] }] }), { mode: 0o600 });
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    (process.stdout as { write: unknown }).write = (chunk: string) => { out.push(String(chunk)); return true; };
    let code: number;
    try {
      code = await main(["enable", "--config", file, "--vault", "v", "--expected-destination", "0".repeat(64)]);
    } finally {
      (process.stdout as { write: unknown }).write = write;
    }
    expect(code).toBe(1);
    expect(JSON.parse(out.join("")).enabled).toBe(false);
    expect(existsSync(join(b.repo, ".git", "vault-sync", "enablement.json"))).toBe(false);
  });
});
