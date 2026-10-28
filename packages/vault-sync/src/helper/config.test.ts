import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHelperConfig, parseHelperConfig } from "./config.ts";
import { main } from "./cli.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "vsh-config-")));
  dirs.push(dir);
  return dir;
}

const base = (path: string, extra: Record<string, unknown> = {}) => ({ configVersion: 1, machineId: "spike-mac", vaults: [{ id: "a", path, include: ["notes"], ...extra }] });

describe("helper configuration", () => {
  test("accepts explicit registrations and resolves real paths", async () => {
    const dir = scratch();
    mkdirSync(join(dir, "vault"));
    symlinkSync(join(dir, "vault"), join(dir, "alias"));
    const cfg = await parseHelperConfig(base(join(dir, "alias"), { exclude: ["notes/drafts"] }));
    expect(cfg).toEqual({ machineId: "spike-mac", captureIntervalMs: 60_000, vaults: [{ id: "a", path: join(dir, "vault"), scope: { include: ["notes"], exclude: ["notes/drafts"] }, remote: "origin" }] });
  });

  test("refuses anything that is not an explicit, unique, absolute registration", async () => {
    const dir = scratch();
    mkdirSync(join(dir, "vault"));
    symlinkSync(join(dir, "vault"), join(dir, "alias"));
    const vault = join(dir, "vault");
    await expect(parseHelperConfig(base("relative/vault"))).rejects.toThrow("absolute");
    await expect(parseHelperConfig({ ...base(vault), discover: true })).rejects.toThrow("unexpected field");
    await expect(parseHelperConfig(base(vault, { command: "rm" }))).rejects.toThrow("unexpected field");
    await expect(parseHelperConfig({ ...base(vault), configVersion: 3 })).rejects.toThrow("configVersion");
    await expect(parseHelperConfig({ ...base(vault), configVersion: 2 })).rejects.toThrow("tools");
    await expect(parseHelperConfig({ ...base(vault), vaults: [] })).rejects.toThrow("vaults");
    await expect(parseHelperConfig(base(vault, { include: [] }))).rejects.toThrow("include");
    await expect(parseHelperConfig(base(vault, { remote: "--upload-pack=x" }))).rejects.toThrow("remote");
    await expect(parseHelperConfig({ ...base(vault), captureIntervalMs: 10 })).rejects.toThrow("captureIntervalMs");
    await expect(parseHelperConfig({ ...base(vault), machineId: "../x" })).rejects.toThrow("machineId");
    const twice = { configVersion: 1, machineId: "m", vaults: [{ id: "a", path: vault, include: ["n"] }, { id: "b", path: join(dir, "alias"), include: ["n"] }] };
    await expect(parseHelperConfig(twice)).rejects.toThrow("same folder twice");
    const sameId = { configVersion: 1, machineId: "m", vaults: [{ id: "a", path: vault, include: ["n"] }, { id: "a", path: dir, include: ["n"] }] };
    await expect(parseHelperConfig(sameId)).rejects.toThrow("repeats");
  });

  test("refuses a configuration file others could have written, or a link to one", async () => {
    const dir = scratch();
    mkdirSync(join(dir, "vault"));
    const file = join(dir, "helper.json");
    writeFileSync(file, JSON.stringify(base(join(dir, "vault"))));
    chmodSync(file, 0o600);
    expect((await loadHelperConfig(file)).vaults).toHaveLength(1);
    chmodSync(file, 0o620);
    await expect(loadHelperConfig(file)).rejects.toThrow("writable by group or others");
    chmodSync(file, 0o600);
    symlinkSync(file, join(dir, "link.json"));
    await expect(loadHelperConfig(join(dir, "link.json"))).rejects.toThrow("regular file");
    await expect(loadHelperConfig(file, 12345)).rejects.toThrow("owned by");
    await expect(loadHelperConfig("helper.json")).rejects.toThrow("absolute");
  });
});

describe("command line", () => {
  test("run needs an explicit runtime bound; there is no install or enrol command", async () => {
    const dir = scratch();
    await expect(main(["run", "--config", join(dir, "c.json"), "--runtime-dir", join(dir, "rt")])).rejects.toThrow("usage");
    for (const command of ["install", "enable", "register", "bootstrap"]) {
      await expect(main([command, "--runtime-dir", join(dir, "rt")])).rejects.toThrow("usage");
    }
    await expect(main(["run", "--config", "x", "--runtime-dir", "y", "--max-runtime-ms", "1", "--exec", "sh"])).rejects.toThrow();
  });
});
