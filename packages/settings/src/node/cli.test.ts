import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runSettingsCli, type SettingsCliOptions } from "./cli.ts";
import { defineRegistry } from "../../../commands/src/index.ts";
import { commandsAdapter } from "../commands-adapter.ts";
import { commands, schema, tempDir } from "./node-fixture.test-support.ts";

interface Run {
  code: number;
  out: string;
  err: string;
  json: Record<string, unknown> & { [k: string]: any };
}

function cli(dir: string, more: Partial<SettingsCliOptions> = {}, env: Record<string, string> = {}) {
  const opts: SettingsCliOptions = { app: "editorexample", appName: "Example Editor", dir, schema, registry: commands, version: "0.31.0", ...more };
  return async (...argv: string[]): Promise<Run> => {
    let out = "";
    let err = "";
    let n = 0;
    const code = await runSettingsCli(argv, opts, {
      stdout: (t) => (out += t), stderr: (t) => (err += t), env, cwd: dir, hostName: "Test Mac", now: () => 1_760_000_000_000, newId: () => `e${++n}-${Math.random().toString(36).slice(2, 8)}`,
    });
    let json = {};
    if (argv.includes("--json") && out.startsWith("{")) json = JSON.parse(out); // tests of `--` and option values check plain text themselves
    return { code, out, err, json };
  };
}

const saved = (d: string) => JSON.parse(readFileSync(join(d, "settings.json"), "utf8"));

describe("settings CLI", () => {
  it("list: every setting with its value; secrets marked, never a value", async () => {
    const run = cli(tempDir());
    const r = await run("list", "--json");
    expect(r.code).toBe(0);
    expect(r.json.settings).toHaveLength(schema.settings.length);
    expect(r.json.settings[1]).toEqual({ key: "editor.proseSize", label: "Prose size", section: "editor", type: "number", value: 16, default: 16, changed: false });
    expect(r.json.settings.find((x: { key: string }) => x.key === "accounts.speech")).toMatchObject({ type: "secret", value: null, secret: true });
    const t = await run("list", "--section", "editor");
    expect(t.out).toBe("editor.proseSize = 16 pt\neditor.focusMode = Off\n");
    expect((await run("list", "--section", "nope")).code).toBe(2);
  });

  it("set and get: logged who agent, with the name from --agent or BRIDLE_AGENT", async () => {
    const d = tempDir();
    const r = await cli(d)("set", "editor.proseSize", "18", "--json");
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, changed: true, entries: [{ key: "editor.proseSize", from: 16, to: 18, who: { kind: "agent", name: "agent" } }] });
    await cli(d)("set", "editor.focusMode", "on", "--agent", "Claude Code");
    await cli(d, {}, { BRIDLE_AGENT: "Codex" })("set", "appearance.theme", "Dark");
    expect(saved(d).changes.map((e: { who: { name: string } }) => e.who.name)).toEqual(["Codex", "Claude Code", "agent"]);
    const g = await cli(d)("get", "editor.proseSize", "--json");
    expect(g.json).toMatchObject({ key: "editor.proseSize", value: 18, default: 16, changed: true, lastChange: { to: 18 } });
    expect((await cli(d)("get", "appearance.theme")).out).toBe("dark\n");
    const again = await cli(d)("set", "editor.proseSize", "18", "--json");
    expect(again.json).toMatchObject({ ok: true, changed: false, entries: [] });
  });

  it("refuses bad input with exit 2 and changes nothing", async () => {
    const d = tempDir();
    const run = cli(d);
    expect((await run("set", "editor.proseSize", "99")).code).toBe(2);
    expect((await run("set", "editor.proseSize", "big")).code).toBe(2);
    expect((await run("set", "no.such", "1")).code).toBe(2);
    expect((await run("get", "no.such")).code).toBe(2);
    expect((await run("frobnicate")).code).toBe(2);
    expect((await run()).code).toBe(2);
    expect((await run("set", "editor.proseSize")).code).toBe(2);
    expect((await run("list", "--yes")).code).toBe(2);
    expect((await run("list", "--wat")).code).toBe(2);
    expect((await run("changes", "--limit", "0")).code).toBe(2);
    const j = await run("set", "editor.proseSize", "99", "--json");
    expect(j.json).toMatchObject({ ok: false, exit: 2, error: expect.stringContaining("at most 32") });
    expect(existsSync(join(d, "settings.json"))).toBe(false);
  });

  it("bounds the agent name", async () => {
    const d = tempDir();
    expect((await cli(d)("set", "editor.focusMode", "on", "--agent", "x".repeat(201))).code).toBe(2);
    expect((await cli(d, {}, { BRIDLE_AGENT: "bad\u001bname" })("set", "editor.focusMode", "on")).code).toBe(2);
    expect((await cli(d)("set", "editor.focusMode", "on", "--agent", "x".repeat(200))).code).toBe(0);
    expect((await cli(d, {}, { BRIDLE_AGENT: "   " })("set", "editor.proseSize", "20")).code).toBe(0);
    expect(saved(d).changes[0].who).toEqual({ kind: "agent", name: "agent" });
  });

  it("refuses to set a secret, points to Accounts and keys, and never echoes the value", async () => {
    const d = tempDir();
    const r = await cli(d)("set", "accounts.speech", "sk-live-SECRET");
    expect(r.code).toBe(2);
    expect(r.err).toContain("Example Editor › Settings › Accounts and keys");
    expect(r.out + r.err).not.toContain("SECRET");
    const j = await cli(d)("set", "accounts.speech", "sk-live-SECRET", "--json");
    expect(j.json).toMatchObject({ ok: false, exit: 2, code: "secret" });
    expect(j.out).not.toContain("SECRET");
    expect((await cli(d)("get", "accounts.speech", "--json")).json).toMatchObject({ value: null, secret: true });
    expect(existsSync(join(d, "settings.json"))).toBe(false);
  });

  it("reset: one key, a section, or all (all needs --yes, exit 3 without)", async () => {
    const d = tempDir();
    const run = cli(d);
    await run("set", "editor.proseSize", "18");
    await run("set", "editor.focusMode", "on");
    await run("set", "appearance.theme", "dark");
    const one = await run("reset", "appearance.theme", "--json");
    expect(one.json).toMatchObject({ ok: true, entries: [{ key: "appearance.theme", from: "dark", to: "light", who: { kind: "agent" } }] });
    const sec = await run("reset", "--section", "editor", "--json");
    expect(sec.json.entries).toHaveLength(2);
    expect(sec.json.batch).toBeString();
    await run("set", "editor.proseSize", "20");
    const ask = await run("reset", "--all", "--json");
    expect(ask.code).toBe(3);
    expect(ask.json).toMatchObject({ ok: false, exit: 3, needsConfirmation: true, count: 1 });
    expect(saved(d).settings).toEqual({ "editor.proseSize": 20 });
    expect((await run("reset", "--all", "--yes")).code).toBe(0);
    expect(saved(d).settings).toEqual({});
    expect((await run("reset", "--all")).code).toBe(0); // nothing left to confirm
    expect((await run("reset")).code).toBe(2);
    expect((await run("reset", "editor.proseSize", "--all", "--yes")).code).toBe(2);
    expect((await run("reset", "accounts.speech")).code).toBe(2);
  });

  it("changes: newest first, with --limit", async () => {
    const d = tempDir();
    const run = cli(d);
    for (const n of ["17", "18", "19"]) await run("set", "editor.proseSize", n);
    const r = await run("changes", "--limit", "2", "--json");
    expect(r.json.total).toBe(3);
    expect(r.json.changes.map((e: { to: number }) => e.to)).toEqual([19, 18]);
    const t = await run("changes");
    expect(t.out.split("\n")[0]).toContain("editor.proseSize  18 pt → 19 pt  by agent agent");
  });

  it("export writes a file without secrets and never over an existing one; import previews (exit 3), applies with --yes, and undo-import reverses it", async () => {
    const a = tempDir();
    await cli(a)("set", "editor.proseSize", "22");
    await cli(a)("set", "library.folder", "~/Elsewhere");
    const ex = await cli(a)("export", "out.json", "--json");
    expect(ex.json).toEqual({ ok: true, file: join(a, "out.json"), settings: 2, keys: 0 });
    const file = JSON.parse(readFileSync(join(a, "out.json"), "utf8"));
    expect(file).toMatchObject({ format: "bridle-settings-export", app: "editorexample", exportedFrom: "Test Mac", settings: { "editor.proseSize": 22 } });
    expect(JSON.stringify(file)).not.toContain("accounts.speech");
    expect((await cli(a)("export", "out.json")).code).toBe(2);

    const b = tempDir();
    writeFileSync(join(b, "in.json"), readFileSync(join(a, "out.json")));
    await cli(b)("set", "editor.focusMode", "on");
    const pv = await cli(b)("import", "in.json", "--json");
    expect(pv.code).toBe(3);
    expect(pv.json).toMatchObject({ ok: false, exit: 3, needsConfirmation: true, preview: { changes: [{ key: "editor.proseSize", from: 16, to: 22 }, { key: "library.folder" }], alreadyMatch: 0 } });
    expect(saved(b).settings).toEqual({ "editor.focusMode": true });
    const text = await cli(b)("import", "in.json");
    expect(text.code).toBe(3);
    expect(text.out).toContain("Run again with --yes");
    const ap = await cli(b)("import", "in.json", "--yes", "--json");
    expect(ap.code).toBe(0);
    expect(ap.json).toMatchObject({ ok: true, applied: true, batch: expect.any(String) });
    expect(ap.json.entries.every((e: { who: { kind: string; file: string; by: unknown } }) => e.who.kind === "import" && e.who.file === "in.json" && (e.who.by as { kind: string }).kind === "agent")).toBe(true);
    expect(saved(b).settings).toEqual({ "editor.focusMode": true, "editor.proseSize": 22, "library.folder": "~/Elsewhere" });
    const nothing = await cli(b)("import", "in.json", "--json");
    expect(nothing.code).toBe(0);
    expect(nothing.json).toMatchObject({ ok: true, applied: false, preview: { changes: [], alreadyMatch: 2 } });
    const un = await cli(b)("undo-import", "--last", "--json");
    expect(un.code).toBe(0);
    expect(un.json.entries).toHaveLength(2);
    expect(saved(b).settings).toEqual({ "editor.focusMode": true });
    expect((await cli(b)("undo-import", "no-such-batch")).code).toBe(2);
    expect((await cli(b)("undo-import")).code).toBe(2);
    expect((await cli(b)("undo-import", "--last", "x")).code).toBe(2);
    const otherBatch = saved(b).changes.find((e: { batch?: string; who: { kind: string } }) => e.batch && e.who.kind === "reset")?.batch;
    expect(otherBatch).toBeString();
    expect((await cli(b)("undo-import", otherBatch)).code).toBe(2); // not an import
  });

  it("import refuses another app's file, a non-export and a missing file with exit 2", async () => {
    const d = tempDir();
    writeFileSync(join(d, "other.json"), JSON.stringify({ format: "bridle-settings-export", version: 1, app: "otherexample", settings: {}, keys: {} }));
    writeFileSync(join(d, "junk.json"), "{nope");
    const o = await cli(d)("import", "other.json", "--yes", "--json");
    expect(o.json).toMatchObject({ ok: false, exit: 2, refused: { code: "other-app" } });
    expect((await cli(d)("import", "junk.json", "--yes")).code).toBe(2);
    expect((await cli(d)("import", "missing.json")).code).toBe(2);
  });

  it("exits 4 with a plain message when the file stays locked for 5 s", async () => {
    const d = tempDir();
    writeFileSync(join(d, "settings.json.lock"), JSON.stringify({ pid: process.pid, at: Date.now(), nonce: "app" }));
    const t0 = Date.now();
    const r = await cli(d)("set", "editor.proseSize", "18");
    const took = Date.now() - t0;
    expect(r.code).toBe(4);
    expect(took).toBeGreaterThanOrEqual(4_900);
    expect(took).toBeLessThan(7_000);
    expect(r.err).toBe("The settings file is busy: another app or agent is changing it. Try again in a moment\n");
    expect(existsSync(join(d, "settings.json.lock"))).toBe(true); // the live lock is left alone
    const j = await cli(d, { lock: { waitMs: 100 } })("set", "editor.proseSize", "18", "--json");
    expect(j.json).toMatchObject({ ok: false, exit: 4, code: "locked" });
  }, 15_000);

  it("exits 1 when the settings file cannot be written (another app's file)", async () => {
    const d = tempDir();
    writeFileSync(join(d, "settings.json"), JSON.stringify({ format: "bridle-settings", version: 2, app: "otherexample", settings: {}, keys: {}, changes: [] }));
    const r = await cli(d)("set", "editor.proseSize", "18", "--json");
    expect(r.json).toMatchObject({ ok: false, exit: 1, code: "refused" });
  });
});

describe("settings CLI: fix round 1", () => {
  it("undo-import of a batch whose every setting changed again since is not possible (exit 2), not a save failure", async () => {
    const d = tempDir();
    const run = cli(d);
    writeFileSync(join(d, "in.json"), JSON.stringify({ format: "bridle-settings-export", version: 1, app: "editorexample", appVersion: "0.31.0", exportedAt: 0, exportedFrom: "X", settings: { "editor.proseSize": 22 }, keys: {} }));
    expect((await run("import", "in.json", "--yes")).code).toBe(0);
    await run("set", "editor.proseSize", "24");
    const r = await run("undo-import", "--last", "--json");
    expect(r.code).toBe(2);
    expect(r.json).toMatchObject({ ok: false, exit: 2, code: "not-possible" });
  });

  it("read verbs on a refused file exit 1 and print no value; with --json the error is only in the JSON", async () => {
    const d = tempDir();
    const other = JSON.stringify({ format: "bridle-settings", version: 2, app: "otherexample", settings: { "editor.proseSize": 30 }, keys: {}, changes: [] });
    writeFileSync(join(d, "settings.json"), other);
    const g = await cli(d)("get", "editor.proseSize");
    expect(g.code).toBe(1);
    expect(g.out).toBe("");
    expect(g.err).toContain("another app");
    const j = await cli(d)("get", "editor.proseSize", "--json");
    expect(j.code).toBe(1);
    expect(j.json).toMatchObject({ ok: false, exit: 1 });
    expect(j.err).toBe("");
    for (const verb of [["list"], ["changes"]]) expect((await cli(d)(...verb)).code).toBe(1);
    const e = tempDir();
    writeFileSync(join(e, "target.json"), other);
    symlinkSync(join(e, "target.json"), join(e, "settings.json"));
    const l = await cli(e)("get", "editor.proseSize");
    expect(l.code).toBe(1);
    expect(l.out).toBe("");
  });

  it("takes the output mode from parsed options only: `--` ends options", async () => {
    const d = tempDir();
    const r = await cli(d)("set", "readAloud.skipPrefix", "--", "--json");
    expect(r.code).toBe(0);
    expect(() => JSON.parse(r.out)).toThrow();
    expect(saved(d).settings["readAloud.skipPrefix"]).toBe("--json");
    const v = await cli(d)("set", "--agent", "--json", "editor.proseSize", "18");
    expect(v.code).toBe(0);
    expect(saved(d).changes[0].who).toEqual({ kind: "agent", name: "--json" });
    expect(() => JSON.parse(v.out)).toThrow();
  });

  it("escapes control characters from the file in text output", async () => {
    const d = tempDir();
    const evil = "\u001b]0\u0007\u009b";
    writeFileSync(join(d, "settings.json"), JSON.stringify({
      format: "bridle-settings", version: 2, app: "editorexample", settings: { "readAloud.skipPrefix": evil }, keys: {},
      changes: [{ id: "e1", at: 0, key: "readAloud.skipPrefix", from: null, to: evil, who: { kind: "agent", name: "x" } }],
    }));
    for (const argv of [["get", "readAloud.skipPrefix"], ["list"], ["changes"]]) {
      const r = await cli(d)(...argv);
      expect(r.code).toBe(0);
      expect(r.out).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
      expect(r.out).toContain("\\u001b]0\\u0007\\u009b");
    }
    writeFileSync(join(d, "in.json"), JSON.stringify({ format: "bridle-settings-export", version: 1, app: "editorexample", appVersion: "1\u001b[31m", exportedAt: 0, exportedFrom: "Mac\u001b[2J", settings: { "editor.proseSize": 20, "no.such\u001b[1m": 1 }, keys: {} }));
    const p = await cli(d)("import", "in.json");
    expect(p.code).toBe(3);
    expect(p.out).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    expect(p.out).toContain("Mac\\u001b[2J");
    const j = await cli(d)("get", "readAloud.skipPrefix", "--json");
    expect(j.json.value).toBe(evil);
  });
});

describe("settings CLI: fix round 2", () => {
  it("a damaged file that cannot be set aside: every verb, reads included, exits 1 and prints no value", async () => {
    const d = tempDir();
    const stamp = new Date(1_760_000_000_000).toISOString().replace(/[:.]/g, "-"); // the CLI helper's clock
    for (let i = 0; i < 100; i++) writeFileSync(join(d, `settings.json.damaged-${stamp}${i ? `-${i}` : ""}`), "older");
    writeFileSync(join(d, "settings.json"), "{damaged original");
    for (const argv of [["get", "editor.proseSize"], ["list"], ["changes"], ["set", "editor.proseSize", "18"]]) {
      const r = await cli(d)(...argv);
      expect({ argv, code: r.code, out: r.out }).toEqual({ argv, code: 1, out: "" });
      expect(r.err).toContain("could not be set aside");
    }
    const j = await cli(d)("get", "editor.proseSize", "--json");
    expect(j.json).toMatchObject({ ok: false, exit: 1, code: "refused", problem: "unarchived" });
    expect(j.json.value).toBeUndefined();
    expect(readFileSync(join(d, "settings.json"), "utf8")).toBe("{damaged original");
  });
  it("rebind: sets a user chord through the same whole-set check; a reserved or taken chord fails and writes nothing", async () => {
    const d = tempDir();
    const run = cli(d);
    const r = await run("rebind", "rename", "cmd+alt+r", "--json", "--agent", "Claude Code");
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, changed: true, entries: [{ commandId: "rename", from: "⌘R", to: "⌘⌥R", who: { kind: "agent", name: "Claude Code" } }] });
    expect(saved(d).keys).toEqual({ rename: "⌘⌥R" });
    const bytes = readFileSync(join(d, "settings.json"), "utf8");
    const reserved = await run("rebind", "pin", "⌘Q", "--json");
    expect(reserved.code).toBe(2);
    expect(reserved.json).toMatchObject({ ok: false, exit: 2, code: "invalid-chord", error: "⌘Q is reserved" });
    const taken = await run("rebind", "pin", "⌘K");
    expect(taken.code).toBe(2);
    expect(taken.err).toContain("taken");
    expect((await run("rebind", "no-such", "⌘J")).code).toBe(2);
    expect((await run("rebind", "editor.proseSize", "⌘J")).code).toBe(2);
    expect((await run("rebind", "pin", "hyper+j")).code).toBe(2);
    expect(readFileSync(join(d, "settings.json"), "utf8")).toBe(bytes);
    expect((await run("rebind", "rename", "⌥⌘R")).out).toBe("Nothing changed; it already had that value\n");
    const none = await run("rebind", "pin", "none", "--json");
    expect(none.json.entries[0]).toMatchObject({ commandId: "pin", from: "⌘D", to: "" });
  });

  it("reset-shortcut: one command, or --all after confirmation", async () => {
    const d = tempDir();
    const run = cli(d);
    await run("rebind", "rename", "⌘J");
    await run("rebind", "pin", "⌘L");
    await run("set", "shortcuts.globalHotkey", "⌥⌘Space");
    const one = await run("reset-shortcut", "rename", "--json");
    expect(one.json).toMatchObject({ ok: true, entries: [{ commandId: "rename", from: "⌘J", to: "⌘R" }] });
    expect((await run("reset-shortcut", "rename", "--json")).json).toMatchObject({ ok: true, changed: false });
    await run("rebind", "rename", "⌘J");
    const ask = await run("reset-shortcut", "--all", "--json");
    expect(ask.code).toBe(3);
    expect(ask.json).toMatchObject({ ok: false, exit: 3, needsConfirmation: true, count: 2 });
    expect(saved(d).keys).toEqual({ rename: "⌘J", pin: "⌘L" });
    const all = await run("reset-shortcut", "--all", "--yes", "--json");
    expect(all.code).toBe(0);
    expect(all.json.entries).toHaveLength(2);
    expect(all.json.batch).toBeString();
    expect(saved(d).keys).toEqual({});
    expect(saved(d).settings).toEqual({ "shortcuts.globalHotkey": "⌥⌘Space" }); // settings untouched
    expect((await run("reset-shortcut", "--all")).out).toBe("Nothing to reset: every shortcut has its default\n");
    expect((await run("reset-shortcut")).code).toBe(2);
    expect((await run("reset-shortcut", "rename", "--all")).code).toBe(2);
    expect((await run("reset-shortcut", "rename", "--yes")).code).toBe(2);
    expect((await run("reset-shortcut", "no-such")).code).toBe(2);
  });
});


it("CLI shares estate rebinding and platform refusal through the registry adapter", async () => {
  const registry = defineRegistry([{ id: "palette", group: "Go", label: "Palette", key: "⌘⇧P", icon: "x", fixed: true }], { rebindableEstateDefaults: true });
  const dir = tempDir();
  const run = cli(dir, { registry: commandsAdapter(registry) });
  expect((await run("rebind", "palette", "cmd+alt+p", "--json")).code).toBe(0);
  const before = readFileSync(join(dir, "settings.json"), "utf8");
  for (const [chord, reason] of [["cmd+ctrl+alt+shift+r", /four modifiers|Raycast/], ["ctrl+right", /Spaces|Mission Control/]] as const) {
    const refused = await run("rebind", "palette", chord, "--json");
    expect(refused.code).toBe(2);
    expect(refused.json.error).toMatch(reason);
    expect(readFileSync(join(dir, "settings.json"), "utf8")).toBe(before);
  }
  expect((await run("rebind", "palette", "cmd+ctrl+shift+right", "--json")).code).toBe(0);
  expect(saved(dir).keys.palette).toBe("⌘⌃⇧→");
});
