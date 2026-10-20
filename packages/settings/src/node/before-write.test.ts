import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadState } from "../load.ts";
import { RULE_FAILED, type WriteProposal } from "../write-check.ts";
import { runSettingsCli } from "./cli.ts";
import { commands, openStore, schema, tempDir } from "./node-fixture.test-support.ts";

const fileIn = (d: string) => join(d, "settings.json");
const saved = (d: string) => JSON.parse(readFileSync(fileIn(d), "utf8"));
const NO_FOCUS = "Reading focus cannot be on with a prose size over 20";
/** A cross-setting rule: focus mode and a large prose size do not go together. */
const rule = (p: WriteProposal) =>
  p.next.settings["editor.focusMode"] === true && Number(p.next.settings["editor.proseSize"] ?? 16) > 20 ? { reject: NO_FOCUS } : undefined;

describe("SettingsStore: beforeWrite", () => {
  it("a rejected write leaves the file untouched and gives the caller the reason", async () => {
    const d = tempDir();
    const s = await openStore(d, { beforeWrite: rule });
    expect((await s.set("editor.proseSize", 24)).ok).toBe(true);
    const bytes = readFileSync(fileIn(d), "utf8");
    const mtime = statSync(fileIn(d)).mtimeMs;
    const r = await s.set("editor.focusMode", true);
    expect(r).toEqual({ ok: false, code: "rejected", error: NO_FOCUS });
    expect(readFileSync(fileIn(d), "utf8")).toBe(bytes);
    expect(statSync(fileIn(d)).mtimeMs).toBe(mtime);
    expect(s.view().settings).toEqual({ "editor.proseSize": 24 });
  });

  it("sees the whole proposal once per write, frozen, for every store route and the CLI", async () => {
    const d = tempDir();
    const seen: WriteProposal[] = [];
    const hook = (p: WriteProposal) => {
      seen.push(p);
      expect(Object.isFrozen(p.next.settings)).toBe(true);
      try {
        (p.next.settings as Record<string, unknown>)["editor.proseSize"] = 31; // cannot reach what is written
      } catch {
        /* frozen */
      }
    };
    const s = await openStore(d, { beforeWrite: hook });
    await s.set("editor.proseSize", 18);
    expect(seen[0]).toMatchObject({ route: "set", who: { kind: "you" }, keys: ["editor.proseSize"], commandIds: [], before: { settings: {} }, next: { settings: { "editor.proseSize": 18 } } });
    expect(saved(d).settings).toEqual({ "editor.proseSize": 18 });
    await s.rebind("rename", "⌘⌥R");
    await s.reset("editor.proseSize");
    await s.set("editor.focusMode", true);
    await s.resetSection("editor");
    await s.set("appearance.theme", "dark");
    const one = s.view().changes[0]!.id;
    await s.resetEntry(one);
    await s.resetShortcuts();
    await s.resetAll(); // nothing changed from default: no write, no call
    await s.recordSecret("accounts.speech", "missing", "connected");
    const exp = JSON.stringify({ format: "bridle-settings-export", version: 1, app: "editorexample", settings: { "editor.proseSize": 12 }, keys: {} });
    const imp = await s.applyImport(s.previewImport(exp), { file: "a.json" });
    await s.undoBatch(imp.ok ? imp.batch! : "");
    const code = await runSettingsCli(["set", "editor.focusMode", "on"], { app: "editorexample", dir: d, schema, registry: commands, version: "0.31.0", beforeWrite: hook }, { stdout: () => {}, stderr: () => {} });
    expect(code).toBe(0);
    expect(seen.map((p) => p.route)).toEqual(["set", "rebind", "reset", "set", "reset-section", "set", "reset-entry", "reset-shortcuts", "record-secret", "import", "undo", "set"]);
    expect(seen[1]!.commandIds).toEqual(["rename"]);
    expect(seen[9]!.who).toEqual({ kind: "you" });
    expect(seen.at(-1)!.who).toEqual({ kind: "agent", name: "agent" });
    expect(seen.every((p) => p.entries.length > 0)).toBe(true);
  });

  it("the CLI refuses with exit 2 and the reason, and writes nothing", async () => {
    const d = tempDir();
    writeFileSync(fileIn(d), JSON.stringify({ format: "bridle-settings", version: 2, app: "editorexample", settings: { "editor.proseSize": 24 }, keys: {}, changes: [] }));
    const before = readFileSync(fileIn(d), "utf8");
    let out = "";
    const code = await runSettingsCli(["set", "editor.focusMode", "on", "--json"], { app: "editorexample", dir: d, schema, registry: commands, version: "0.31.0", beforeWrite: rule }, { stdout: (t) => (out += t), stderr: () => {} });
    expect(code).toBe(2);
    expect(JSON.parse(out)).toMatchObject({ ok: false, exit: 2, code: "rejected", error: NO_FOCUS });
    expect(readFileSync(fileIn(d), "utf8")).toBe(before);
  });

  it("a throw or a promise refuses the write (fails closed) and is logged", async () => {
    const d = tempDir();
    const a = await openStore(d, { beforeWrite: () => { throw new Error("boom"); } });
    expect(await a.set("editor.proseSize", 18)).toEqual({ ok: false, code: "rejected", error: RULE_FAILED });
    expect(a.lines.some((l) => l.includes("boom"))).toBe(true);
    const b = await openStore(d, { beforeWrite: (async () => undefined) as never });
    expect(await b.set("editor.proseSize", 18)).toMatchObject({ code: "rejected" });
    expect(existsSync(fileIn(d))).toBe(false);
  });

  it("judges a migration as the app update; a rejected migration leaves the legacy file as it is", async () => {
    const d = tempDir();
    writeFileSync(fileIn(d), JSON.stringify({ fontSize: 22 }));
    const migrate = (old: unknown) => ({ settings: { "editor.proseSize": (old as { fontSize: number }).fontSize } });
    const seen: WriteProposal[] = [];
    await openStore(d, { migrate, beforeWrite: (p) => (seen.push(p), { reject: "not yet" }) });
    expect(seen[0]).toMatchObject({ route: "migration", who: { kind: "app-update", version: "0.31.0" }, keys: ["editor.proseSize"] });
    expect(saved(d)).toEqual({ fontSize: 22 });
    await openStore(d, { migrate, beforeWrite: () => undefined });
    expect(saved(d).settings).toEqual({ "editor.proseSize": 22 });
  });

  it("does not judge the loader's pure repairs: an invalid saved value is put back to default whatever the rule says", async () => {
    const d = tempDir();
    writeFileSync(fileIn(d), JSON.stringify({ format: "bridle-settings", version: 2, app: "editorexample", settings: { "editor.proseSize": 999 }, keys: {}, changes: [] }));
    let calls = 0;
    await openStore(d, { beforeWrite: () => (calls++, { reject: "no" }) });
    expect(calls).toBe(0);
    expect(saved(d).settings).toEqual({});
    expect(saved(d).changes[0]).toMatchObject({ key: "editor.proseSize", note: "INVALID_SAVED_VALUE" });
  });

  it("a refused change still lets the loader's pure repair through, unjudged: the rule cannot keep a bad value or a secret on disk", async () => {
    const d = tempDir();
    const routes: string[] = [];
    const s = await openStore(d, { beforeWrite: (p) => (routes.push(p.route), { reject: "no" }) });
    writeFileSync(fileIn(d), JSON.stringify({ format: "bridle-settings", version: 2, app: "editorexample", settings: { "editor.proseSize": 999, "accounts.speech": "sk-secret" }, keys: {}, changes: [] }));
    expect(await s.set("appearance.theme", "dark")).toEqual({ ok: false, code: "rejected", error: "no" });
    expect(routes).toEqual(["set"]);
    expect(saved(d).settings).toEqual({});
    expect(readFileSync(fileIn(d), "utf8")).not.toContain("sk-secret");
    expect(saved(d).changes[0]).toMatchObject({ key: "editor.proseSize", note: "INVALID_SAVED_VALUE" });
  });

  it("a refused change on a file whose only fault is a stray secret still drops the secret, unjudged", async () => {
    const d = tempDir();
    const routes: string[] = [];
    const s = await openStore(d, { beforeWrite: (p) => (routes.push(p.route), { reject: "no" }) });
    writeFileSync(fileIn(d), JSON.stringify({ format: "bridle-settings", version: 2, app: "editorexample", settings: { "editor.proseSize": 18, "accounts.speech": "sk-stray" }, keys: {}, changes: [] }));
    expect(await s.set("appearance.theme", "dark")).toEqual({ ok: false, code: "rejected", error: "no" });
    expect(routes).toEqual(["set"]);
    expect(readFileSync(fileIn(d), "utf8")).not.toContain("sk-stray");
    expect(saved(d).settings).toEqual({ "editor.proseSize": 18 }); // the refused theme is not written
    expect(saved(d).changes).toEqual([]);
  });

  // A load that leaves anything out is a pure repair: whatever the loader dropped (a secret under any name, in any shape) is written out.
  const v2File = (extra: object) => JSON.stringify({ format: "bridle-settings", version: 2, app: "editorexample", settings: { "editor.proseSize": 18 }, keys: {}, changes: [], ...extra });
  const entry = { id: "s1", at: 1, key: "accounts.speech", from: "missing", to: "sk-ant-hidden", who: { kind: "you" } };
  for (const [why, extra] of [
    ["an entry about a secret with a malformed origin", { changes: [{ ...entry, toOrigin: "bad" }] }],
    ["an entry about a secret with a bad batch", { changes: [{ ...entry, batch: 5 }] }],
    ["an entry about a secret with a bad note", { changes: [{ ...entry, note: "NOT_A_NOTE" }] }],
    ["a kept status entry with an extra field", { changes: [{ ...entry, to: "connected", leak: "sk-ant-hidden" }] }],
    ["an entry nested in a list", { changes: [[{ key: "accounts.speech", to: "sk-ant-hidden" }]] }],
    ["a secret nested under an unknown setting", { settings: { "editor.proseSize": 18, ghost: { "accounts.speech": "sk-ant-hidden" } } }],
    ["a secret nested under an unknown shortcut", { keys: { ghost: { "accounts.speech": "sk-ant-hidden" } } }],
    ["a secret under an unknown name", { settings: { "editor.proseSize": 18, ghost: "sk-ant-hidden" } }],
    ["a secret in an unknown top-level field", { backup: "sk-ant-hidden" }],
  ] as const) {
    it(`a refused change still writes out ${why}, unjudged`, async () => {
      const d = tempDir();
      const routes: string[] = [];
      const s = await openStore(d, { beforeWrite: (p) => (routes.push(p.route), { reject: "no" }) });
      writeFileSync(fileIn(d), v2File(extra));
      expect(await s.set("appearance.theme", "dark")).toEqual({ ok: false, code: "rejected", error: "no" });
      expect(routes).toEqual(["set"]);
      expect(readFileSync(fileIn(d), "utf8")).not.toContain("sk-ant-hidden");
      expect(saved(d).settings).toEqual({ "editor.proseSize": 18 });
      expect(saved(d).changes.every((c: { to: unknown }) => c.to === "connected")).toBe(true); // only a status entry, rebuilt, may stay
    });
  }

  it("a file found at open with a 150,000-element changelog of junk: the store opens and the file is repaired", async () => {
    const d = tempDir();
    writeFileSync(fileIn(d), v2File({ changes: Array.from({ length: 150_000 }, () => 0) }));
    let calls = 0;
    const s = await openStore(d, { beforeWrite: () => (calls++, { reject: "no" }) });
    expect(calls).toBe(0);
    expect(s.view().settings).toEqual({ "editor.proseSize": 18 });
    expect(saved(d)).toEqual({ format: "bridle-settings", version: 2, app: "editorexample", settings: { "editor.proseSize": 18 }, keys: {}, changes: [] });
  });

  it("a refused change leaves a clean file byte for byte as it was", async () => {
    const d = tempDir();
    const s = await openStore(d, { beforeWrite: () => ({ reject: "no" }) });
    const status = { id: "k", at: 1, key: "accounts.speech", from: "missing", to: "connected", who: { kind: "you" } };
    const kept = { id: "n1", at: 2, key: "editor.proseSize", from: 16, to: 18, who: { kind: "you" }, fromOrigin: "local", toOrigin: "local" };
    const text = v2File({ keys: {}, changes: [kept, status] });
    writeFileSync(fileIn(d), text);
    expect(await s.set("appearance.theme", "dark")).toMatchObject({ code: "rejected" });
    expect(readFileSync(fileIn(d), "utf8")).toBe(text);
  });
});

describe("SettingsStore: beforeWrite on a legacy file", () => {
  const migrate = (old: unknown) => {
    const o = old as { folder?: string; fontSize?: number };
    return { settings: { ...(o.folder !== undefined ? { "library.folder": o.folder } : {}), ...(o.fontSize !== undefined ? { "editor.proseSize": o.fontSize } : {}) } };
  };
  const DENIED = "That folder is not allowed";
  const noDenied = (p: WriteProposal) => (p.next.settings["library.folder"] === "/denied" ? { reject: DENIED } : undefined);

  it("a refused change ends the write: a legacy file put in place under an open store is not migrated by it, and the rule runs once", async () => {
    const d = tempDir();
    const routes: string[] = [];
    const s = await openStore(d, { migrate, beforeWrite: (p) => (routes.push(p.route), p.route === "set" ? { reject: "no sets" } : undefined) });
    writeFileSync(fileIn(d), JSON.stringify({ fontSize: 22 })); // replaced behind the store (no watcher here)
    const legacy = readFileSync(fileIn(d), "utf8");
    expect(await s.set("appearance.theme", "dark")).toEqual({ ok: false, code: "rejected", error: "no sets" });
    expect(readFileSync(fileIn(d), "utf8")).toBe(legacy);
    expect(routes).toEqual(["set"]);
    expect(s.view().settings).toEqual({}); // the unwritten migration is not shown either
    // The next read judges the migration on its own.
    await s.reload();
    expect(routes).toEqual(["set", "migration"]);
    expect(saved(d).settings).toEqual({ "editor.proseSize": 22 });
  });

  it("a migration of only defaults, with no changelog entries, is still judged and, refused, not written", async () => {
    const d = tempDir();
    writeFileSync(fileIn(d), JSON.stringify({ fontSize: 16 }));
    const seen: WriteProposal[] = [];
    const s = await openStore(d, { migrate, beforeWrite: (p) => (seen.push(p), { reject: "not yet" }) });
    expect(seen.map((p) => [p.route, p.entries.length])).toEqual([["migration", 0]]);
    expect(saved(d)).toEqual({ fontSize: 16 });
    expect(s.problem()).toEqual({ code: "rejected", error: "not yet" });
  });

  it("a refused migration is never shown: the view is the defaults with no history, problem() says why, and a reload keeps it so", async () => {
    const d = tempDir();
    writeFileSync(fileIn(d), JSON.stringify({ folder: "/denied", fontSize: 22 }));
    const s = await openStore(d, { migrate, beforeWrite: noDenied });
    expect(saved(d)).toEqual({ folder: "/denied", fontSize: 22 });
    expect(s.view().settings).toEqual({});
    expect(s.view().changes).toEqual([]);
    expect(s.problem()).toEqual({ code: "rejected", error: DENIED });
    expect(s.lines.filter((l) => l.includes(DENIED))).toHaveLength(1);
    await s.reload();
    expect(s.view().settings).toEqual({});
    expect(s.view().changes).toEqual([]);
    expect(s.problem()).toEqual({ code: "rejected", error: DENIED });
    expect(s.lines.filter((l) => l.includes(DENIED))).toHaveLength(1); // logged once per reason
    // A change carries the migration and is judged with it: still refused while the path is in it.
    expect(await s.set("appearance.theme", "dark")).toMatchObject({ code: "rejected", error: DENIED });
    expect(s.view().settings).toEqual({});
    expect(s.problem()).toMatchObject({ code: "rejected" });
    // A legacy file the rule accepts clears the problem.
    writeFileSync(fileIn(d), JSON.stringify({ folder: "/fine" }));
    await s.reload();
    expect(s.problem()).toBeUndefined();
    expect(s.view().settings).toEqual({ "library.folder": "/fine" });
  });

  it("the CLI's get on a refused migration prints the default, not the migrated path, and says why on stderr (exit 0)", async () => {
    const d = tempDir();
    writeFileSync(fileIn(d), JSON.stringify({ folder: "/denied" }));
    let out = "";
    let err = "";
    const opts = { app: "editorexample", dir: d, schema, registry: commands, version: "0.31.0", migrate, beforeWrite: noDenied };
    const io = { stdout: (t: string) => (out += t), stderr: (t: string) => (err += t) };
    expect(await runSettingsCli(["get", "library.folder", "--json"], opts, io)).toBe(0);
    const got = JSON.parse(out);
    expect(got).toMatchObject({ key: "library.folder", value: "~/Documents/Writing", changed: false, problem: { code: "rejected", error: DENIED } });
    expect(got.lastChange).toBeUndefined();
    expect(err).toContain(DENIED);
    out = "";
    err = "";
    expect(await runSettingsCli(["get", "library.folder"], opts, io)).toBe(0);
    expect(out).toBe("~/Documents/Writing\n");
    expect(err).toContain(DENIED);
    expect(saved(d)).toEqual({ folder: "/denied" });
  });
});

describe("SettingsStore: who app-update", () => {
  it("a store opened as the app update logs app-update entries that read back, and the rule sees that actor", async () => {
    const d = tempDir();
    const seen: WriteProposal[] = [];
    const s = await openStore(d, { who: { kind: "app-update", version: "0.32.0" }, beforeWrite: (p) => void seen.push(p) });
    const r = await s.set("editor.proseSize", 20);
    expect(r.ok && r.entries[0]!.who).toEqual({ kind: "app-update", version: "0.32.0" });
    expect(seen[0]!.who).toEqual({ kind: "app-update", version: "0.32.0" });
    await s.reset("editor.proseSize");
    const id = s.view().changes[0]!.id;
    await s.resetEntry(id);
    expect(s.view().changes[0]!.who).toEqual({ kind: "reset", of: id, by: { kind: "app-update", version: "0.32.0" } });
    const back = loadState(saved(d), { schema, commands, appVersion: "0.32.0", now: () => 0, newId: () => "x" });
    expect(back.dropped).toEqual([]);
    expect(back.state.changes).toEqual(saved(d).changes);
  });
});
