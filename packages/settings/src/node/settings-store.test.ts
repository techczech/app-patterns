import { describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INVALID_SAVED_VALUE } from "../changes.ts";
import { exportFile } from "../transfer.ts";
import { runSettingsCli } from "./cli.ts";
import { commands, openStore, schema, sleep, tempDir, until } from "./node-fixture.test-support.ts";

const fileIn = (d: string) => join(d, "settings.json");
const saved = (d: string) => JSON.parse(readFileSync(fileIn(d), "utf8"));
const v2 = (settings: Record<string, unknown>, more: Record<string, unknown> = {}) =>
  JSON.stringify({ format: "bridle-settings", version: 2, app: "editorexample", settings, keys: {}, changes: [], ...more });

describe("SettingsStore: file", () => {
  it("persists settings, shortcuts and the changelog across stores, in a private file with no temporary file left", async () => {
    const d = tempDir();
    const a = await openStore(d);
    expect((await a.set("editor.proseSize", 18)).ok).toBe(true);
    expect((await a.rebind("rename", "⌘⌥R")).ok).toBe(true);
    const b = await openStore(d);
    expect(b.view().settings).toEqual({ "editor.proseSize": 18 });
    expect(b.view().keys).toEqual({ rename: "⌘⌥R" });
    expect(b.view().changes.map((e) => e.key ?? e.commandId)).toEqual(["rename", "editor.proseSize"]);
    expect(saved(d)).toMatchObject({ format: "bridle-settings", version: 2, app: "editorexample" });
    expect(statSync(fileIn(d)).mode & 0o777).toBe(0o600);
    expect(readdirSync(d)).toEqual(["settings.json"]); // no temp file, no lock left behind
  });

  it("re-reads under the lock: a store with a stale view never overwrites a newer file", async () => {
    const d = tempDir();
    const a = await openStore(d);
    const b = await openStore(d); // not watching: its view is stale after a's write
    await a.set("editor.proseSize", 20);
    expect(b.view().settings).toEqual({});
    const r = await b.set("editor.focusMode", true);
    expect(r.ok).toBe(true);
    expect(saved(d).settings).toEqual({ "editor.proseSize": 20, "editor.focusMode": true });
    expect(b.view().settings).toEqual({ "editor.proseSize": 20, "editor.focusMode": true });
    expect(saved(d).changes).toHaveLength(2);
  });

  it("logs nothing and writes nothing for a value already in place", async () => {
    const d = tempDir();
    const s = await openStore(d);
    await s.set("editor.proseSize", 18);
    const before = readFileSync(fileIn(d), "utf8");
    const r = await s.set("editor.proseSize", 18);
    expect(r).toMatchObject({ ok: true, entries: [] });
    expect(readFileSync(fileIn(d), "utf8")).toBe(before);
  });

  it("a damaged file is set aside as .damaged-<timestamp>, defaults load, one entry is logged", async () => {
    const d = tempDir();
    writeFileSync(fileIn(d), "{not json");
    const s = await openStore(d, { now: () => Date.UTC(2026, 9, 19, 12, 0, 0) });
    const aside = readdirSync(d).filter((n) => n.startsWith("settings.json.damaged-"));
    expect(aside).toEqual(["settings.json.damaged-2026-10-19T12-00-00-000Z"]);
    expect(readFileSync(join(d, aside[0]!), "utf8")).toBe("{not json");
    expect(s.view().settings).toEqual({});
    expect(s.view().changes).toEqual([expect.objectContaining({ key: "changes", from: null, to: null, note: INVALID_SAVED_VALUE, who: { kind: "app-update", version: "0.31.0" } })]);
    expect(saved(d).changes).toHaveLength(1); // the entry is on disk too
    expect(s.lines.some((l) => l.includes("set aside as settings.json.damaged-"))).toBe(true);
    // A second damage does not overwrite the first file set aside.
    writeFileSync(fileIn(d), "[1, 2]"); // JSON, but not a settings file
    await s.reload();
    expect(readdirSync(d).filter((n) => n.includes(".damaged-"))).toHaveLength(2);
  });

  it("treats a file over 1 MB as damaged", async () => {
    const d = tempDir();
    writeFileSync(fileIn(d), v2({}, { pad: "x".repeat(1024 * 1024) }));
    const s = await openStore(d);
    expect(readdirSync(d).some((n) => n.includes(".damaged-"))).toBe(true);
    expect(s.view().settings).toEqual({});
  });

  it("writes back the loader's repairs once (an invalid saved value)", async () => {
    const d = tempDir();
    writeFileSync(fileIn(d), v2({ "editor.proseSize": 999, "editor.focusMode": true }));
    const s = await openStore(d);
    expect(s.view().settings).toEqual({ "editor.focusMode": true });
    expect(saved(d).settings).toEqual({ "editor.focusMode": true });
    expect(saved(d).changes).toEqual([expect.objectContaining({ key: "editor.proseSize", note: INVALID_SAVED_VALUE })]);
    const again = await openStore(d);
    expect(again.view().changes).toHaveLength(1);
  });

  it("runs the app's migrate hook on a legacy file and writes the result as v2", async () => {
    const d = tempDir();
    writeFileSync(fileIn(d), JSON.stringify({ fontSize: 20 }));
    const s = await openStore(d, { migrate: (old) => ({ settings: { "editor.proseSize": (old as { fontSize: number }).fontSize } }) });
    expect(s.view().settings).toEqual({ "editor.proseSize": 20 });
    expect(saved(d)).toMatchObject({ format: "bridle-settings", version: 2, settings: { "editor.proseSize": 20 } });
    expect(saved(d).changes[0].who).toEqual({ kind: "app-update", version: "0.31.0" });
  });

  it("never reads through a symlinked file and never replaces it", async () => {
    const d = tempDir();
    const target = join(d, "elsewhere.json");
    writeFileSync(target, v2({ "editor.proseSize": 30 }));
    symlinkSync(target, fileIn(d));
    const s = await openStore(d);
    expect(s.view().settings).toEqual({});
    const r = await s.set("editor.proseSize", 12);
    expect(r).toMatchObject({ ok: false, code: "refused" });
    expect(JSON.parse(readFileSync(target, "utf8")).settings).toEqual({ "editor.proseSize": 30 });
  });

  it("refuses a settings folder that is a symlink", async () => {
    const d = tempDir();
    mkdirSync(join(d, "real"));
    symlinkSync(join(d, "real"), join(d, "link"));
    const s = await openStore(join(d, "link"));
    expect(await s.set("editor.proseSize", 12)).toMatchObject({ ok: false, code: "refused" });
    expect(existsSync(join(d, "real", "settings.json"))).toBe(false);
  });

  it("refuses a settings folder outside the root it was given", async () => {
    const d = tempDir();
    mkdirSync(join(d, "data"));
    mkdirSync(join(d, "other"));
    const s = await openStore(join(d, "other"), { root: join(d, "data") });
    expect(await s.set("editor.proseSize", 12)).toMatchObject({ ok: false, code: "refused" });
    expect(existsSync(join(d, "other", "settings.json"))).toBe(false);
  });

  it("leaves another app's file, or a newer version's, as it is and refuses changes", async () => {
    for (const text of [v2({}, { app: "otherexample" }), v2({}, { version: 3 })]) {
      const d = tempDir();
      writeFileSync(fileIn(d), text);
      const s = await openStore(d);
      expect(s.problem()?.code).toMatch(/other-app|newer-version/);
      expect(await s.set("editor.proseSize", 12)).toMatchObject({ ok: false, code: "refused" });
      expect(readFileSync(fileIn(d), "utf8")).toBe(text);
    }
  });

  it("refuses changes once quitting has begun", async () => {
    const d = tempDir();
    const s = await openStore(d);
    s.refuseWrites("The app is quitting");
    expect(await s.set("editor.proseSize", 12)).toEqual({ ok: false, code: "closed", error: "The app is quitting" });
    expect(existsSync(fileIn(d))).toBe(false);
    expect(s.view().settings).toEqual({});
  });

  it("reports a lock held past the wait in plain words, and changes nothing", async () => {
    const d = tempDir();
    const s = await openStore(d, { lock: { waitMs: 200 } });
    writeFileSync(`${fileIn(d)}.lock`, JSON.stringify({ pid: process.pid, at: Date.now(), nonce: "x" }));
    const r = await s.set("editor.proseSize", 12);
    expect(r).toMatchObject({ ok: false, code: "locked", error: expect.stringContaining("busy") });
    expect(s.view().settings).toEqual({});
    expect(existsSync(fileIn(d))).toBe(false);
  });

  it("drops the oldest history, never a batch, to keep the file under its size cap", async () => {
    const d = tempDir();
    const s = await openStore(d, { maxBytes: 4_000 });
    for (let i = 0; i < 30; i++) expect((await s.set("readAloud.skipPrefix", `p${i}`)).ok).toBe(true);
    expect(statSync(fileIn(d)).size).toBeLessThanOrEqual(4_000);
    const changes = saved(d).changes;
    expect(changes.length).toBeLessThan(30);
    expect(changes[0].to).toBe("p29");
    expect(s.lines.some((l) => l.includes("oldest"))).toBe(true);
  });

  it("runs undo and import through the lock, attributed to who the store acts for", async () => {
    const d = tempDir();
    const s = await openStore(d, { who: { kind: "agent", name: "Claude Code" } });
    const file = exportFile({ format: "bridle-settings", version: 2, app: "editorexample", settings: { "editor.proseSize": 22, "editor.focusMode": true }, keys: {}, changes: [] }, {
      appVersion: "0.31.0", hostName: "Air", now: 0, schema, commands,
    });
    const done = await s.applyImport(s.previewImport(file), { file: "Example Editor Settings.json" });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.entries.every((e) => e.who.kind === "import" && e.who.by?.kind === "agent")).toBe(true);
    const undo = await s.undoBatch(done.batch!);
    expect(undo.ok).toBe(true);
    expect(saved(d).settings).toEqual({});
  });
});

describe("SettingsStore: secrets", () => {
  it("purges a secret found in the file, refuses to set one, and never exports one", async () => {
    const d = tempDir();
    writeFileSync(fileIn(d), v2({ "accounts.speech": "sk-live-SECRET", "editor.proseSize": 18 }));
    const s = await openStore(d);
    expect(readFileSync(fileIn(d), "utf8")).not.toContain("SECRET");
    expect(s.lines.join("\n")).not.toContain("SECRET");
    expect(await s.set("accounts.speech", "sk-other")).toMatchObject({ ok: false, code: "secret" });
    expect(readFileSync(fileIn(d), "utf8")).not.toContain("sk-other");
    expect(JSON.stringify(s.exportFile({ hostName: "Air" }))).not.toContain("accounts.speech");
  });
});

describe("SettingsStore: watch", () => {
  it("reflects a CLI change within 1 s, once", async () => {
    const d = tempDir();
    const s = await openStore(d, { watch: true });
    await sleep(50);
    const t0 = Date.now();
    const code = await runSettingsCli(["set", "editor.proseSize", "24"], { app: "editorexample", dir: d, schema, registry: commands, version: "0.31.0" }, { stdout: () => {}, stderr: () => {}, env: {} });
    expect(code).toBe(0);
    await until(() => s.view().settings["editor.proseSize"] === 24, 1_000);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(s.changes.at(-1)?.changes[0]).toMatchObject({ key: "editor.proseSize", to: 24, who: { kind: "agent", name: "agent" } });
    await sleep(250);
    expect(s.changes).toHaveLength(1);
    await s.close();
  });

  it("sees a file replaced by rename (a new inode), and an in-place rewrite", async () => {
    const d = tempDir();
    const s = await openStore(d, { watch: true });
    await sleep(50);
    writeFileSync(join(d, "incoming.tmp"), v2({ "editor.proseSize": 26 }));
    renameSync(join(d, "incoming.tmp"), fileIn(d));
    await until(() => s.view().settings["editor.proseSize"] === 26, 1_000);
    writeFileSync(fileIn(d), v2({ "editor.proseSize": 28 }));
    await until(() => s.view().settings["editor.proseSize"] === 28, 1_000);
    await s.close();
  });

  it("watches a folder that did not exist yet (first run)", async () => {
    const d = join(tempDir(), "fresh", "data");
    const s = await openStore(d, { watch: true });
    await sleep(50);
    writeFileSync(fileIn(d), v2({ "editor.proseSize": 21 }));
    await until(() => s.view().settings["editor.proseSize"] === 21, 1_000);
    await s.close();
  });

  it("is not starved by a stream of outside writes", async () => {
    const d = tempDir();
    const s = await openStore(d, { watch: true });
    await sleep(50);
    const t0 = Date.now();
    let i = 10;
    const writer = setInterval(() => writeFileSync(fileIn(d), v2({ "editor.proseSize": Math.min(32, ++i) })), 30);
    try {
      await until(() => s.changes.length > 0, 1_000);
      expect(Date.now() - t0).toBeLessThan(1_000);
    } finally {
      clearInterval(writer);
    }
    await s.close();
  }, 30_000);

  it("does not call onChange again for its own write", async () => {
    const d = tempDir();
    const s = await openStore(d, { watch: true });
    await sleep(50);
    await s.set("editor.focusMode", true);
    await sleep(300);
    expect(s.changes).toHaveLength(1);
    await s.close();
  });
});

describe("SettingsStore: fix round 1", () => {
  it("writes back a migrated file even when the migration yields only defaults (no legacy secret stays on disk)", async () => {
    const d = tempDir();
    writeFileSync(fileIn(d), JSON.stringify({ apiKey: "sk-live-LEGACY", fontSize: 16 }));
    const s = await openStore(d, { migrate: () => ({ settings: {} }) });
    expect(s.view().settings).toEqual({});
    expect(readFileSync(fileIn(d), "utf8")).not.toContain("LEGACY");
    expect(saved(d)).toMatchObject({ format: "bridle-settings", version: 2 });
  });

  it("refuses to write, and keeps the original, when a damaged file cannot be set aside", async () => {
    const d = tempDir();
    const at = Date.UTC(2026, 9, 19, 12, 0, 0);
    const stamp = new Date(at).toISOString().replace(/[:.]/g, "-");
    for (let i = 0; i < 100; i++) writeFileSync(join(d, `settings.json.damaged-${stamp}${i ? `-${i}` : ""}`), "older");
    writeFileSync(fileIn(d), "{damaged original");
    const s = await openStore(d, { now: () => at });
    const r = await s.set("editor.proseSize", 18);
    expect(r).toMatchObject({ ok: false, code: "refused" });
    expect(readFileSync(fileIn(d), "utf8")).toBe("{damaged original");
    expect(s.problem()).toMatchObject({ code: "unarchived" }); // the app sees why, as the CLI does
  });

  it("treats a literal null, or a top level that is not an object, as damaged", async () => {
    for (const text of ["null", "5", '"text"', "true"]) {
      const d = tempDir();
      writeFileSync(fileIn(d), text);
      const s = await openStore(d);
      const aside = readdirSync(d).filter((n) => n.includes(".damaged-"));
      expect(aside).toHaveLength(1);
      expect(readFileSync(join(d, aside[0]!), "utf8")).toBe(text);
      expect(s.view().changes[0]).toMatchObject({ note: INVALID_SAVED_VALUE });
    }
  });

  it("sets a damaged file aside private (0600) and keeps only the 3 newest", async () => {
    const d = tempDir();
    let t = Date.UTC(2026, 9, 19, 12, 0, 0);
    const s = await openStore(d, { now: () => t });
    for (let i = 0; i < 5; i++) {
      writeFileSync(fileIn(d), `{"secret": "sk-${i}"`, { mode: 0o644 });
      chmodSync(fileIn(d), 0o644);
      t += 1_000;
      await s.reload();
    }
    const aside = readdirSync(d).filter((n) => n.includes(".damaged-")).sort();
    expect(aside).toHaveLength(3);
    expect(aside.map((n) => readFileSync(join(d, n), "utf8"))).toEqual(['{"secret": "sk-2"', '{"secret": "sk-3"', '{"secret": "sk-4"']);
    for (const n of aside) expect(statSync(join(d, n)).mode & 0o777).toBe(0o600);
  });

  it("removes a temporary file left by a writer that died mid-write", async () => {
    const d = tempDir();
    const p = Bun.spawn(["bun", "-e", "0"]);
    await p.exited;
    const orphan = join(d, `.settings.json.${p.pid}.abcdef012345.tmp`);
    writeFileSync(orphan, '{"half":');
    const old = join(d, `.settings.json.${process.pid}.0123456789ab.tmp`);
    writeFileSync(old, "x");
    const t = (Date.now() - 61_000) / 1000;
    utimesSync(old, t, t);
    const fresh = join(d, `.settings.json.${process.pid}.ffffffffffff.tmp`);
    writeFileSync(fresh, "x");
    const s = await openStore(d);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true); // a live process's, and recent
    writeFileSync(orphan, '{"half":');
    await s.set("editor.proseSize", 18);
    expect(existsSync(orphan)).toBe(false);
  });
});

describe("SettingsStore: watch while opening", () => {
  it("sees an outside change made just after the first read (before the old code started watching)", async () => {
    const d = tempDir();
    writeFileSync(fileIn(d), v2({ "editor.proseSize": 20 }));
    let first = true;
    const s = await openStore(d, {
      watch: true,
      testHooks: {
        afterRead: () => {
          if (!first) return;
          first = false;
          writeFileSync(fileIn(d), v2({ "editor.proseSize": 30 }));
          return sleep(300).then(() => undefined); // a slow start: the old code installed its watcher only after this
        },
      },
    });
    await until(() => s.view().settings["editor.proseSize"] === 30, 1_000);
    await s.close();
  });
});

describe("SettingsStore: fix round 2", () => {
  it("a damaged file set aside before the holder lost the lock: the retry still writes the defaults and the damage entry", async () => {
    const d = tempDir();
    writeFileSync(fileIn(d), "{damaged");
    let evicted = false;
    const s = await openStore(d, {
      testHooks: {
        beforeCommit: () => {
          if (evicted) return;
          evicted = true;
          // Evicted before the first commit: our lock is gone and another (alive, fresh) holder has it for a moment.
          unlinkSync(`${fileIn(d)}.lock`);
          writeFileSync(`${fileIn(d)}.lock`, JSON.stringify({ pid: process.pid, at: Date.now(), nonce: "intruder", host: "h" }));
          setTimeout(() => unlinkSync(`${fileIn(d)}.lock`), 150);
        },
      },
    });
    expect(evicted).toBe(true);
    expect(existsSync(fileIn(d))).toBe(true);
    expect(saved(d).changes).toHaveLength(1);
    expect(saved(d).changes[0]).toMatchObject({ key: "changes", note: INVALID_SAVED_VALUE });
    expect(s.view().changes[0]).toMatchObject({ note: INVALID_SAVED_VALUE });
    expect(readdirSync(d).filter((n) => n.includes(".damaged-"))).toHaveLength(1);
  });
});

describe("SettingsStore: keys in the changelog", () => {
  it("recordSecret writes one entry with who and status words to the file, and nothing else", async () => {
    const d = tempDir();
    const s = await openStore(d, { who: { kind: "agent", name: "cli" } });
    const r = await s.recordSecret("accounts.speech", "missing", "connected");
    expect(r).toMatchObject({ ok: true, entries: [{ key: "accounts.speech", from: "missing", to: "connected", who: { kind: "agent", name: "cli" } }] });
    expect(saved(d).settings).toEqual({});
    expect(saved(d).changes).toEqual([expect.objectContaining({ key: "accounts.speech", from: "missing", to: "connected" })]);
    expect((await openStore(d)).view().changes).toHaveLength(1);
    expect((await s.recordSecret("editor.proseSize", "missing", "connected")).ok).toBe(false);
    expect(saved(d).changes).toHaveLength(1);
  });
});
