/** Regression tests: secrets cannot enter by any door, shortcut sets are judged whole, history survives reload, undo keeps later changes, the cap holds. */
import { describe, expect, test } from "bun:test";
import { CHANGELOG_KEY, INVALID_SAVED_VALUE, MAX_CHANGES, type ChangeEntry } from "./changes.ts";
import { commands, fresh, makeCtx, must, schema } from "./fixture.test-support.ts";
import { loadState } from "./load.ts";
import { rebind, rebindMany, reset, resetAll, set, undoBatch } from "./operations.ts";
import { defineSchema, type SettingDef } from "./schema.ts";
import { chordOf, emptyState, valueOf } from "./state.ts";
import { applyImport, exportFile, previewImport } from "./transfer.ts";

const EXPORT_OPTS = { appVersion: "0.31.0", hostName: "Example Mac", now: 0, schema, commands };
const env = { schema, commands };
const loadCtx = { schema, commands, appVersion: "0.31.0", now: () => 0, newId: () => "ld" };
const exported = (over: object) => ({ ...exportFile(fresh(), EXPORT_OPTS), ...over });

describe("a secret cannot enter through the shortcut map", () => {
  test("import skips it, rebind refuses it, export and load drop it", () => {
    const p = previewImport(fresh(), exported({ keys: { "accounts.speech": "TEST-SECRET" } }), env);
    expect(p.changes).toEqual([]);
    expect(p.skipped).toEqual([{ commandId: "accounts.speech", reason: "That is a setting, not a command" }]);
    const a = must(applyImport(fresh(), p, { file: "f.json" }, makeCtx()));
    expect(JSON.stringify(a.state)).not.toContain("TEST-SECRET");
    expect(rebind(fresh(), "accounts.speech", "TEST-SECRET", makeCtx())).toMatchObject({ ok: false, code: "unknown-command" });
    const leaked = { ...fresh(), keys: { "accounts.speech": "TEST-SECRET", ghost: "⌥G", rename: "⌥⌘R" } };
    expect(exportFile(leaked, EXPORT_OPTS).keys).toEqual({ rename: "⌥⌘R" });
    const r = loadState(leaked, loadCtx);
    expect(r.state.keys).toEqual({ rename: "⌥⌘R" });
    expect(JSON.stringify(r)).not.toContain("TEST-SECRET");
  });
});

describe("the loader rebuilds history from known fields", () => {
  test("drops entries about a secret and unknown properties at every level", () => {
    const raw = {
      ...fresh(),
      changes: [
        { id: "s", at: 1, key: "accounts.speech", from: null, to: "TEST-SECRET", who: { kind: "you" } },
        { id: "c", at: 1, commandId: "accounts.speech", from: "", to: "TEST-SECRET", who: { kind: "you" } },
        { id: "k", at: 1, key: "editor.proseSize", from: 16, to: 18, who: { kind: "agent", name: "A", token: "TEST-SECRET" }, extra: { token: "TEST-SECRET" } },
        { id: "i", at: 1, key: "editor.proseSize", from: 18, to: 20, batch: "b", who: { kind: "import", file: "f", skipped: [{ key: "x", reason: "r", value: "TEST-SECRET" }], by: { kind: "you", x: "TEST-SECRET" } } },
      ],
    };
    const r = loadState(raw, loadCtx);
    expect(JSON.stringify(r.state)).not.toContain("TEST-SECRET");
    expect(r.state.changes).toEqual([
      { id: "k", at: 1, key: "editor.proseSize", from: 16, to: 18, who: { kind: "agent", name: "A" } },
      { id: "i", at: 1, key: "editor.proseSize", from: 18, to: 20, batch: "b", who: { kind: "import", file: "f", skipped: [{ key: "x", reason: "r" }], by: { kind: "you" } } },
    ]);
    expect(r.dropped).toEqual(["changes: 2 about a secret"]);
  });
});

describe("shortcut sets are judged whole", () => {
  const swapped = () => must(rebindMany(fresh(), [{ commandId: "rename", chord: "⌘D" }, { commandId: "pin", chord: "⌘R" }], makeCtx())).state;

  test("a swap survives a reload", () => {
    const r = loadState(JSON.parse(JSON.stringify(swapped())), loadCtx);
    expect(r.state.keys).toEqual({ rename: "⌘D", pin: "⌘R" });
    expect(r.entries).toEqual([]);
  });

  test("resetting one side of a swap is refused: the default chord would collide", () => {
    const st = swapped();
    expect(reset(st, { commandId: "rename" }, makeCtx())).toMatchObject({ ok: false, code: "invalid-chord" });
    expect(reset(st, { commandId: "pin" }, makeCtx())).toMatchObject({ ok: false, code: "invalid-chord" });
    expect(must(resetAll(st, makeCtx())).state.keys).toEqual({}); // both together is fine
  });

  test("partial undo judges the shortcuts it restores against what is really kept", () => {
    const ctx = makeCtx({ kind: "you" }, 1000, "u");
    const p = previewImport(fresh(), exported({ keys: { rename: "⌥1", pin: "⌥2" } }), env);
    const a = must(applyImport(fresh(), p, { file: "f.json" }, ctx));
    const later = must(rebind(a.state, "rename", "⌘D", ctx)).state;
    const u = undoBatch(later, a.batch!, ctx);
    expect(u.ok).toBe(false);
    expect(u.skipped?.map((s) => s.commandId).sort()).toEqual(["pin", "rename"]);
    // Nothing changed, and no two commands share a chord.
    expect(chordOf(later, "rename", commands)).toBe("⌘D");
    expect(chordOf(later, "pin", commands)).toBe("⌥2");
  });

  test("a preview offers only shortcuts the whole set accepts, so applying it succeeds", () => {
    for (const keys of [{ pin: "⌘R", rename: "⌘Q" }, { rename: "⌘Q", pin: "⌘R" }]) {
      const p = previewImport(fresh(), exported({ keys }), env);
      expect(p.changes).toEqual([]);
      expect(p.skipped.map((s) => s.commandId).sort()).toEqual(["pin", "rename"]);
      must(applyImport(fresh(), p, { file: "f.json" }, makeCtx()));
    }
    const ok = previewImport(fresh(), exported({ keys: { pin: "⌘R", rename: "⌥⌘E" } }), env);
    expect(ok.changes.map((c) => c.commandId).sort()).toEqual(["pin", "rename"]);
    expect(must(applyImport(fresh(), ok, { file: "f.json" }, makeCtx())).state.keys).toEqual({ pin: "⌘R", rename: "⌥⌘E" });
  });
});

describe("import metadata is bounded so the batch survives reload", () => {
  test("a 201-character unknown key in the file", () => {
    const long = "x".repeat(201);
    const p = previewImport(fresh(), exported({ settings: { "editor.proseSize": 18, [long]: 1 }, exportedFrom: "M".repeat(500) }), env);
    expect(p.skipped[0]!.key).toHaveLength(200);
    const a = must(applyImport(fresh(), p, { file: "F".repeat(2000) }, { ...makeCtx(), by: { kind: "agent", name: "N".repeat(500) } }));
    const back = loadState(JSON.parse(JSON.stringify(a.state)), loadCtx);
    expect(back.state.changes).toEqual(a.state.changes);
    expect(back.state.changes[0]!.batch).toBe(a.batch!);
  });
});

describe("undo keeps a setting touched since, whatever its value now", () => {
  test("16 → 18 imported, then 20, then 18 again", () => {
    const ctx = makeCtx({ kind: "you" }, 1000, "h");
    const p = previewImport(fresh(), exported({ settings: { "editor.proseSize": 18, "editor.focusMode": true } }), env);
    let st = must(applyImport(fresh(), p, { file: "f.json" }, ctx)).state;
    const batch = st.changes[0]!.batch!;
    st = must(set(st, "editor.proseSize", 20, ctx)).state;
    st = must(set(st, "editor.proseSize", 18, ctx)).state;
    const u = must(undoBatch(st, batch, ctx));
    expect(valueOf(u.state, schema, "editor.proseSize")).toBe(18);
    expect(valueOf(u.state, schema, "editor.focusMode")).toBe(false);
    expect(u.skipped).toEqual([{ key: "editor.proseSize", reason: "Changed again since; its later value is kept" }]);
  });
});

describe("the changelog cap holds for one batch too", () => {
  const many: SettingDef[] = Array.from({ length: MAX_CHANGES + 1 }, (_, i) => ({ key: `t.${i}`, label: `T${i}`, section: "general", type: "toggle", default: false }));
  const big = defineSchema({ app: "editorexample", settings: many });

  test("an operation that would log more than the cap changes nothing", () => {
    const ctx = { ...makeCtx(), schema: big };
    const st = { ...emptyState("editorexample"), settings: Object.fromEntries(many.map((d) => [d.key, true])) };
    expect(resetAll(st, ctx)).toMatchObject({ ok: false, code: "too-many" });
    const p = previewImport(emptyState("editorexample"), exported({ settings: st.settings }), { schema: big, commands });
    expect(p.refused?.code).toBe("too-many");
  });

  test("the loader drops an oversized batch whole and says so", () => {
    const changes = Array.from({ length: 1000 }, (_, i) => ({ id: `e${i}`, at: 5, key: "editor.proseSize", from: 16, to: 18, who: { kind: "you" }, batch: "B" }));
    const keep: ChangeEntry = { id: "k", at: 1, key: "editor.focusMode", from: false, to: true, who: { kind: "you" } };
    const r = loadState({ ...fresh(), changes: [...changes, keep] }, loadCtx);
    expect(r.entries).toEqual([{ id: "ld", at: 0, key: CHANGELOG_KEY, from: 1000, to: null, who: { kind: "app-update", version: "0.31.0" }, note: INVALID_SAVED_VALUE }]);
    expect(r.state.changes).toEqual([...r.entries, keep]);
    expect(() => defineSchema({ app: "x", settings: [{ key: CHANGELOG_KEY, label: "C", section: "general", type: "toggle", default: false }] })).toThrow();
  });
});
