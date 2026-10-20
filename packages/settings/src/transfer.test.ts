import { describe, expect, test } from "bun:test";
import { INVALID_SAVED_VALUE, isChangeEntry, MAX_CHANGES, readEntry } from "./changes.ts";
import { CHANGED_VALUES, SETTINGS, commands, fresh, makeCtx, schema, must } from "./fixture.test-support.ts";
import { defineSchema, NOT_IMPORTABLE, SchemaError } from "./schema.ts";
import { loadState } from "./load.ts";
import { rebind, resetEntry, set, undoBatch } from "./operations.ts";
import { batchOf, changeCounts, lastImportBatch } from "./queries.ts";
import { valueOf, type SettingsState } from "./state.ts";
import { applyImport, exportFile, previewImport } from "./transfer.ts";


function allChanged(): SettingsState {
  const ctx = makeCtx();
  let st = fresh();
  for (const [k, v] of Object.entries(CHANGED_VALUES)) st = must(set(st, k, v, ctx)).state;
  return must(rebind(st, "go-to-heading", "⇧⌘O", ctx)).state;
}

const EXPORT_OPTS = { appVersion: "0.31.0", hostName: "Example Mac", now: Date.UTC(2026, 9, 17, 18, 4), schema, commands };
const env = { schema, commands, apply: { pathExists: (p: string) => p !== "~/Dropbox/Writing" } };

describe("loadState is tolerant", () => {
  const ctx = makeCtx({ kind: "you" }, 7000, "ld");

  test("round-trips its own file", () => {
    const st = allChanged();
    const r = loadState(JSON.parse(JSON.stringify(st)), ctx);
    expect(r.problem).toBeUndefined();
    expect(r.entries).toEqual([]);
    expect(r.state).toEqual(st);
  });

  test("an invalid field falls back to its default and logs INVALID_SAVED_VALUE without the value", () => {
    const st = { ...allChanged(), settings: { ...allChanged().settings, "editor.proseSize": 999, "appearance.theme": "purple", "accounts.speech": "sk-secret", "gone.key": 1 } };
    const r = loadState(st, ctx);
    expect(valueOf(r.state, schema, "editor.proseSize")).toBe(16);
    expect(valueOf(r.state, schema, "appearance.theme")).toBe("light");
    expect(r.state.settings["accounts.speech"]).toBeUndefined();
    expect(valueOf(r.state, schema, "editor.focusMode")).toBe(true);
    expect(r.entries.map((e) => [e.key, e.from, e.to, e.note, e.who.kind])).toEqual(
      expect.arrayContaining([
        ["editor.proseSize", null, 16, INVALID_SAVED_VALUE, "app-update"],
        ["appearance.theme", null, "light", INVALID_SAVED_VALUE, "app-update"],
      ]),
    );
    expect(r.entries).toHaveLength(2); // a secret gets no entry at all
    expect(JSON.stringify(r.state)).not.toContain("sk-secret");
    expect(r.dropped).toEqual(["settings.accounts.speech", "settings.gone.key"]);
    expect(r.state.changes.slice(0, 2)).toEqual(r.entries);
  });

  test("bad shortcuts, bad changelog entries and wrong shapes are dropped field by field", () => {
    const st = allChanged();
    const raw = { ...st, keys: { rename: "⌘Q", pin: 7, ghost: "⌥G", "insert-link": "⌘K" }, changes: [...st.changes, { id: 1 }, "x"] };
    const r = loadState(raw, ctx);
    expect(r.state.keys).toEqual({});
    expect(r.entries.map((e) => e.commandId).sort()).toEqual(["pin", "rename"]);
    expect(r.dropped).toEqual([`changes[${st.changes.length}]`, `changes[${st.changes.length + 1}]`, "keys.ghost"]);
    expect(r.state.changes.every(isChangeEntry)).toBe(true);
    expect(loadState({ ...st, settings: "nope", keys: [] }, ctx).dropped).toEqual(["settings", "keys"]);
  });

  test("no file, not a settings file, another app, a newer version", () => {
    expect(loadState(undefined, ctx)).toMatchObject({ state: fresh(), entries: [], migrated: false });
    expect(loadState("garbage", ctx).problem).toBe("not-settings");
    expect(loadState({ format: "bridle-settings", version: 1, app: "editorexample" }, ctx).problem).toBe("not-settings");
    expect(loadState({ ...fresh(), app: "recorderexample" }, ctx).problem).toBe("other-app");
    expect(loadState({ ...fresh(), version: 3 }, ctx).problem).toBe("newer-version");
  });

  test("migrate maps a legacy file into one app-update batch", () => {
    const legacy = { theme: "dark", fontSize: 18, fontFamily: "Comic", shortcuts: { rename: "⌥⌘R" } };
    const migrate = (old: unknown) => {
      const o = old as typeof legacy;
      return { settings: { "appearance.theme": o.theme, "editor.proseSize": o.fontSize, "editor.focusMode": "maybe" }, keys: o.shortcuts };
    };
    const r = loadState(legacy, { ...ctx, migrate });
    expect(r.migrated).toBe(true);
    expect(r.state.settings).toEqual({ "appearance.theme": "dark", "editor.proseSize": 18 });
    expect(r.state.keys).toEqual({ rename: "⌥⌘R" });
    expect(r.entries).toHaveLength(4);
    expect(new Set(r.entries.map((e) => e.batch)).size).toBe(1);
    expect(r.entries.every((e) => e.who.kind === "app-update" && e.who.version === "0.31.0")).toBe(true);
    expect(r.entries.find((e) => e.key === "editor.focusMode")?.note).toBe(INVALID_SAVED_VALUE);
    expect(loadState(legacy, { ...ctx, migrate: () => null }).problem).toBe("not-settings");
    expect(loadState(legacy, { ...ctx, migrate: () => { throw new Error("x"); } }).problem).toBe("not-settings");
  });
});

describe("export", () => {
  test("has the v1 shape and never a secret", () => {
    const st = allChanged();
    const leaked = { ...st, settings: { ...st.settings, "accounts.speech": "sk-secret" } };
    const f = exportFile(leaked, EXPORT_OPTS);
    expect(f).toEqual({
      format: "bridle-settings-export", version: 1, app: "editorexample", appVersion: "0.31.0", exportedFrom: "Example Mac",
      exportedAt: "2026-10-17T18:04:00.000Z", settings: CHANGED_VALUES, keys: { "go-to-heading": "⇧⌘O" },
    });
    expect(JSON.stringify(f)).not.toContain("sk-secret");
    for (const d of schema.settings.filter((x) => x.type === "secret")) expect(Object.hasOwn(f.settings, d.key)).toBe(false);
  });
});

describe("import", () => {
  const file = () => JSON.stringify(exportFile(allChanged(), EXPORT_OPTS));

  test("preview counts equal what apply writes, skipped settings are listed, already-matching ones counted", () => {
    const ctx = makeCtx({ kind: "you" }, 20_000, "im");
    const here = must(set(fresh(), "editor.focusMode", true, ctx)).state; // already matches the file
    const p = previewImport(here, file(), env);
    expect(p.refused).toBeUndefined();
    expect(p.alreadyMatch).toBe(1);
    expect(p.skipped).toEqual([{ key: "library.folder", reason: "Not on this Mac" }]);
    expect(p.changes.map((c) => c.key ?? c.commandId)).toEqual(["appearance.theme", "editor.proseSize", "readAloud.skipPrefix", "shortcuts.globalHotkey", "go-to-heading"]);
    expect(p.changes[0]).toEqual({ key: "appearance.theme", from: "light", to: "dark", section: "appearance" });
    expect(p.changes.at(-1)).toEqual({ commandId: "go-to-heading", from: "⇧⌘G", to: "⇧⌘O", section: "shortcuts" });
    expect(p.source).toEqual({ app: "editorexample", appVersion: "0.31.0", exportedFrom: "Example Mac", exportedAt: "2026-10-17T18:04:00.000Z" });

    const a = must(applyImport(here, p, { file: "Example Editor Settings 2026-10-17.json" }, ctx));
    expect(a.entries).toHaveLength(p.changes.length);
    expect(a.entries.every((e) => e.batch === a.batch)).toBe(true);
    const who = a.entries[0]!.who;
    expect(who).toEqual({
      kind: "import", file: "Example Editor Settings 2026-10-17.json", exportedFrom: "Example Mac", exportedAt: "2026-10-17T18:04:00.000Z", appVersion: "0.31.0",
      skipped: [{ key: "library.folder", reason: "Not on this Mac" }],
    });
    for (const c of p.changes) {
      const e = a.entries.find((x) => (c.key ? x.key === c.key : x.commandId === c.commandId))!;
      expect([e.from, e.to]).toEqual([c.from, c.to]);
    }
    expect(changeCounts(a.state).import).toBe(p.changes.length);
    expect(lastImportBatch(a.state)).toBe(a.batch);
    expect(batchOf(a.state, a.batch!)).toMatchObject({ entries: a.entries, skipped: p.skipped, import: { exportedFrom: "Example Mac" } });
    // Previewing again: everything matches now.
    const again = previewImport(a.state, file(), env);
    expect(again.changes).toEqual([]);
    expect(again.alreadyMatch).toBe(p.alreadyMatch + p.changes.length);
  });

  test("one setting imported is still a batch; Undo import restores exact prior values; each entry resets on its own", () => {
    const ctx = makeCtx({ kind: "you" }, 30_000, "un");
    let here = must(set(fresh(), "editor.proseSize", 14, ctx)).state;
    here = must(rebind(here, "rename", "⌥⌘R", ctx)).state;
    const before = structuredClone({ settings: here.settings, keys: here.keys });
    const p = previewImport(here, file(), env);
    const a = must(applyImport(here, p, { file: "f.json" }, { ...ctx, by: { kind: "agent", name: "Claude Code" } }));
    expect(a.entries[0]!.who).toMatchObject({ kind: "import", by: { kind: "agent", name: "Claude Code" } });
    const u = must(undoBatch(a.state, a.batch!, ctx));
    expect({ settings: u.state.settings, keys: u.state.keys }).toEqual(before);

    const one = previewImport(fresh(), JSON.stringify({ ...exportFile(fresh(), EXPORT_OPTS), settings: { "editor.proseSize": 20 } }), env);
    const b = must(applyImport(fresh(), one, { file: "one.json" }, ctx));
    expect(b.entries).toHaveLength(1);
    expect(b.batch).toBeDefined();
    const r = must(resetEntry(a.state, a.entries.find((e) => e.key === "appearance.theme")!.id, ctx));
    expect(valueOf(r.state, schema, "appearance.theme")).toBe("light");
    expect(valueOf(r.state, schema, "editor.proseSize")).toBe(18);
  });

  test("refused: unparsable, wrong format, other app, newer version", () => {
    const st = fresh();
    expect(previewImport(st, "{not json", env).refused?.code).toBe("unparsable");
    expect(previewImport(st, "[]", env).refused?.code).toBe("unparsable");
    expect(previewImport(st, JSON.stringify(st), env).refused?.code).toBe("wrong-format"); // the state file, not an export
    expect(previewImport(st, { format: "bridle-settings-export", version: "1", app: "editorexample" }, env).refused?.code).toBe("wrong-format");
    const other = previewImport(st, { ...exportFile(fresh(), EXPORT_OPTS), app: "recorderexample" }, env);
    expect(other.refused).toEqual({ code: "other-app", message: "These are settings for recorderexample, not for this app", app: "recorderexample" });
    expect(previewImport(st, { ...exportFile(fresh(), EXPORT_OPTS), version: 2 }, env).refused?.code).toBe("newer-version");
    expect(applyImport(st, other, { file: "x" }, makeCtx())).toMatchObject({ ok: false, code: "not-possible" });
  });

  test("skips unknown keys, secrets, invalid values, unknown commands and refused chords", () => {
    const f = {
      ...exportFile(fresh(), EXPORT_OPTS),
      settings: { "gone.key": 1, "accounts.speech": "sk-x", "editor.proseSize": 99 },
      keys: { ghost: "⌥G", rename: "⌘Q", pin: "⌘R", "insert-link": "⌘K" },
    };
    const p = previewImport(fresh(), f, env);
    expect(p.skipped.map((s) => s.key ?? s.commandId)).toEqual(["gone.key", "accounts.speech", "editor.proseSize", "ghost", "rename", "pin"]);
    expect(p.alreadyMatch).toBe(1);
    expect(p.changes).toEqual([]);
  });

  test("a swap in the file is judged against the file's other chords", () => {
    const f = { ...exportFile(fresh(), EXPORT_OPTS), keys: { rename: "⌘D", pin: "⌘R" } };
    const p = previewImport(fresh(), f, env);
    expect(p.skipped).toEqual([]);
    const a = must(applyImport(fresh(), p, { file: "swap.json" }, makeCtx()));
    expect(a.state.keys).toEqual({ rename: "⌘D", pin: "⌘R" });
  });
});

describe("importable: false", () => {
  const runner = { key: "tools.python", label: "Python to run", section: "library", type: "path" as const, default: "", importable: false };
  const s2 = defineSchema({ app: "editorexample", sections: [{ id: "library", label: "Library", icon: "library" }], settings: [...SETTINGS.filter((d) => d.section !== "editor" && d.section !== "readAloud"), runner] });
  const env2 = { schema: s2, commands };
  const file = (settings: Record<string, unknown>) => ({ format: "bridle-settings-export", version: 1, app: "editorexample", settings, keys: {} });

  test("is skipped with the reason \"not importable\", even when the value already matches, and never applied", () => {
    const ctx = { ...makeCtx(), schema: s2 };
    const p = previewImport(fresh(), file({ "tools.python": "/tmp/evil", "appearance.theme": "dark" }), env2);
    expect(p.skipped).toEqual([{ key: "tools.python", reason: NOT_IMPORTABLE }]);
    expect(p.changes.map((c) => c.key)).toEqual(["appearance.theme"]);
    const same = previewImport(fresh(), file({ "tools.python": "" }), env2);
    expect(same.alreadyMatch).toBe(0);
    expect(same.skipped).toEqual([{ key: "tools.python", reason: NOT_IMPORTABLE }]);
    const done = applyImport(fresh(), p, { file: "x.json" }, ctx);
    expect(done.ok && done.state.settings).toEqual({ "appearance.theme": "dark" });
    expect(done.ok && done.entries[0]!.who).toMatchObject({ kind: "import", skipped: [{ key: "tools.python", reason: NOT_IMPORTABLE }] });
    // A preview built by hand cannot slip it in.
    const forged = { ...p, changes: [{ key: "tools.python", from: "", to: "/tmp/evil", section: "library" }] };
    expect(applyImport(fresh(), forged, { file: "x.json" }, ctx)).toMatchObject({ ok: false, code: "invalid-value" });
  });

  test("canApply still skips with its own reason; export still writes the setting", () => {
    const p = previewImport(fresh(), JSON.stringify(exportFile(allChanged(), EXPORT_OPTS)), env);
    expect(p.skipped).toContainEqual({ key: "library.folder", reason: "Not on this Mac" });
    const ctx = { ...makeCtx(), schema: s2 };
    const st = must(set(fresh(), "tools.python", "/usr/bin/python3", ctx), s2).state;
    expect(exportFile(st, { ...EXPORT_OPTS, schema: s2 }).settings).toEqual({ "tools.python": "/usr/bin/python3" });
  });

  test("import history from before the upgrade never writes an imported value to it; the user's own earlier value may come back", () => {
    // Before the upgrade the runner path was importable: the user set their own, then an import replaced it.
    const s1 = defineSchema({ app: "editorexample", sections: [{ id: "library", label: "Library", icon: "library" }], settings: [...SETTINGS.filter((d) => d.section !== "editor" && d.section !== "readAloud"), { ...runner, importable: true }] });
    const old = { ...makeCtx({ kind: "you" }, 40_000, "pre"), schema: s1 };
    const mine = must(set(fresh(), "tools.python", "/usr/bin/python3", old), s1).state;
    const imp = must(applyImport(mine, previewImport(mine, file({ "tools.python": "/tmp/evil", "appearance.theme": "dark" }), { schema: s1, commands }), { file: "old.json" }, old), s1);
    const importEntry = imp.state.changes.find((e) => e.key === "tools.python")!;
    expect(importEntry.who.kind).toBe("import");
    // The user changes it again after the import; that entry's earlier value is the imported one.
    const after = must(set(imp.state, "tools.python", "/opt/py", old), s1).state;
    const later = after.changes[0]!;
    expect(later.from).toBe("/tmp/evil");
    expect(resetEntry(after, later.id, old).ok).toBe(true); // allowed while it was importable
    // The app now marks it importable: false.
    const ctx = { ...makeCtx({ kind: "you" }, 50_000, "post"), schema: s2 };
    // Reset entry on the later change would write the imported value back: refused, "not importable".
    const back = resetEntry(after, later.id, ctx);
    expect(back).toMatchObject({ ok: false, code: "not-possible" });
    expect(!back.ok && back.error).toContain(NOT_IMPORTABLE);
    // Reset entry on the import's own entry writes its `from`, the user's pre-import value: allowed.
    expect(must(resetEntry(after, importEntry.id, ctx), s2).state.settings["tools.python"]).toBe("/usr/bin/python3");
    // Undo import writes the pre-import values: the user's own path comes back, the theme too.
    const undone = must(undoBatch(imp.state, imp.batch!, ctx), s2);
    expect(undone.skipped).toEqual([]);
    expect(undone.state.settings).toEqual({ "tools.python": "/usr/bin/python3" });
    // Undoing that undo would write the imported value back: the runner path is skipped "not importable"; the theme still goes back.
    const redo = must(undoBatch(undone.state, undone.batch!, ctx), s2);
    expect(redo.skipped).toEqual([{ key: "tools.python", reason: NOT_IMPORTABLE }]);
    expect(redo.state.settings).toEqual({ "tools.python": "/usr/bin/python3", "appearance.theme": "dark" });
    // An undo whose every setting is protected writes nothing.
    const onlyRunner = must(applyImport(mine, previewImport(mine, file({ "tools.python": "/tmp/evil" }), { schema: s1, commands }), { file: "old.json" }, old), s1);
    const u1 = must(undoBatch(onlyRunner.state, onlyRunner.batch ?? onlyRunner.entries[0]!.batch ?? "", ctx), s2);
    expect(undoBatch(u1.state, u1.batch!, ctx)).toMatchObject({ ok: false, skipped: [{ key: "tools.python", reason: NOT_IMPORTABLE }] });
  });

  /** The same schema before the upgrade, when the runner path could still be imported. */
  const before = () => defineSchema({ app: "editorexample", sections: [{ id: "library", label: "Library", icon: "library" }], settings: [...SETTINGS.filter((d) => d.section !== "editor" && d.section !== "readAloud"), { ...runner, importable: true }] });
  const importInto = (st: SettingsState, settings: Record<string, unknown>, s1: ReturnType<typeof before>, ctx: ReturnType<typeof makeCtx>) =>
    must(applyImport(st, previewImport(st, file(settings), { schema: s1, commands }), { file: "old.json" }, ctx), s1);

  test("each entry records where both its values came from, and the origin survives the changelog cap", () => {
    const s1 = before();
    const old = { ...makeCtx({ kind: "you" }, 60_000, "cap"), schema: s1 };
    const imp = importInto(fresh(), { "tools.python": "/evil" }, s1, old);
    expect(imp.entries[0]).toMatchObject({ key: "tools.python", from: "", to: "/evil", fromOrigin: "local", toOrigin: "import" });
    let st = must(set(imp.state, "tools.python", "/safe", old), s1).state;
    const safe = st.changes[0]!;
    expect(safe).toMatchObject({ from: "/evil", to: "/safe", fromOrigin: "import", toOrigin: "local" });
    // 299 unrelated changes push the import's own entry out of the log.
    for (let i = 0; i < MAX_CHANGES - 1; i++) st = must(set(st, "appearance.theme", i % 2 ? "light" : "dark", old), s1).state;
    expect(st.changes.some((e) => e.who.kind === "import")).toBe(false);
    expect(st.changes.at(-1)!.id).toBe(safe.id);
    const ctx = { ...makeCtx({ kind: "you" }, 70_000, "cap2"), schema: s2 };
    const r = resetEntry(st, safe.id, ctx);
    expect(r).toMatchObject({ ok: false, code: "not-possible" });
    expect(!r.ok && r.error).toContain(NOT_IMPORTABLE);
  });

  test("a value the user typed again after an import is theirs: resetting or undoing a later import puts it back", () => {
    const s1 = before();
    const old = { ...makeCtx({ kind: "you" }, 80_000, "back"), schema: s1 };
    let st = importInto(fresh(), { "tools.python": "/mine" }, s1, old).state;
    st = must(set(st, "tools.python", "/other", old), s1).state;
    st = must(set(st, "tools.python", "/mine", old), s1).state; // away and back, by hand
    const second = importInto(st, { "tools.python": "/new" }, s1, old);
    const entry = second.state.changes[0]!;
    expect(entry).toMatchObject({ from: "/mine", to: "/new", fromOrigin: "local", toOrigin: "import" });
    const ctx = { ...makeCtx({ kind: "you" }, 90_000, "back2"), schema: s2 };
    const reset = must(resetEntry(second.state, entry.id, ctx), s2);
    expect(reset.state.settings["tools.python"]).toBe("/mine");
    expect(reset.entries[0]).toMatchObject({ to: "/mine", fromOrigin: "import", toOrigin: "local" });
    const undone = must(undoBatch(second.state, second.batch!, ctx), s2);
    expect(undone.skipped).toEqual([]);
    expect(undone.state.settings["tools.python"]).toBe("/mine");
    // But the first import's own value may not come back: undoing the user's change away from it is refused.
    const away = st.changes[1]!;
    expect(away).toMatchObject({ from: "/mine", to: "/other", fromOrigin: "import" });
    expect(resetEntry(must(set(st, "tools.python", "/x", old), s1).state, away.id, ctx)).toMatchObject({ ok: false, code: "not-possible" });
  });

  test("origins read back from the file; an entry without them (an older file) counts as unknown and is never put back into the setting", () => {
    const s1 = before();
    const old = { ...makeCtx({ kind: "you" }, 100_000, "rt"), schema: s1 };
    let st = must(set(fresh(), "tools.python", "/usr/bin/python3", old), s1).state;
    st = must(set(st, "tools.python", "/opt/py", old), s1).state;
    const back = loadState(JSON.parse(JSON.stringify(st)), { schema: s2, commands, appVersion: "0.31.0", now: () => 0, newId: () => "x" });
    expect(back.state.changes).toEqual(st.changes);
    expect(back.state.changes[0]).toMatchObject({ fromOrigin: "local", toOrigin: "local" });
    expect(readEntry({ ...st.changes[0], toOrigin: "elsewhere" })).toBeNull();
    const ctx = { ...makeCtx({ kind: "you" }, 110_000, "rt2"), schema: s2 };
    // Own value, origin recorded: it may go back.
    expect(must(resetEntry(back.state, st.changes[0]!.id, ctx), s2).state.settings["tools.python"]).toBe("/usr/bin/python3");
    // The same file written before origins were recorded: unknown, refused (undo skips it with the same reason).
    const bare = JSON.parse(JSON.stringify(st), (k, v) => (k === "fromOrigin" || k === "toOrigin" ? undefined : v));
    const older = loadState(bare, { schema: s2, commands, appVersion: "0.31.0", now: () => 0, newId: () => "x" });
    expect(older.dropped).toEqual([]);
    expect(older.state.changes[0]!.fromOrigin).toBeUndefined();
    expect(resetEntry(older.state, st.changes[0]!.id, ctx)).toMatchObject({ ok: false, code: "not-possible" });
    // A setting that may be imported is put back whatever the origin.
    expect(resetEntry(older.state, st.changes[0]!.id, { ...ctx, schema: s1 }).ok).toBe(true);
  });

  test("a schema with a non-boolean importable is a programming mistake", () => {
    expect(() => defineSchema({ app: "x", settings: [{ ...runner, section: "general", importable: "no" as unknown as boolean }] })).toThrow(SchemaError);
  });
});
