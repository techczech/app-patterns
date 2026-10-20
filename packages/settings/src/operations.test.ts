import { describe, expect, test } from "bun:test";
import { capChanges, MAX_CHANGES, type ChangeEntry } from "./changes.ts";
import { CHANGED_VALUES, fresh, makeCtx, schema, must } from "./fixture.test-support.ts";
import { changedFromDefault, rebind, rebindMany, reset, resetAll, resetEntry, resetSection, set, undoBatch } from "./operations.ts";
import { batchOf, changeCounts, filterChanges, historyOf, lastChange, newSince, searchSettings } from "./queries.ts";
import { checkValue, defineSchema, formatValue, parseValue, SchemaError } from "./schema.ts";
import { chordOf, valueOf, type SettingsState } from "./state.ts";


describe("every schema key round-trips set / reset / changelog", () => {
  for (const def of schema.settings.filter((d) => d.type !== "secret")) {
    test(def.key, () => {
      const ctx = makeCtx();
      const to = CHANGED_VALUES[def.key]!;
      const a = must(set(fresh(), def.key, to, ctx));
      expect(valueOf(a.state, schema, def.key)).toBe(to);
      expect(a.state.settings).toEqual({ [def.key]: to });
      expect(a.entries).toEqual([{ id: "id1", at: 1000, key: def.key, from: def.default, to, who: { kind: "you" }, fromOrigin: "local", toOrigin: "local" }]);
      expect(a.state.changes).toEqual(a.entries);
      expect(checkValue(def, to)).toBeNull();

      const same = must(set(a.state, def.key, to, ctx));
      expect(same.entries).toEqual([]);
      expect(same.state.changes).toHaveLength(1);

      const b = must(reset(a.state, def.key, ctx));
      expect(b.state.settings).toEqual({});
      expect(valueOf(b.state, schema, def.key)).toBe(def.default);
      expect(b.entries[0]).toMatchObject({ key: def.key, from: to, to: def.default, who: { kind: "you" } });
      expect(historyOf(b.state, def.key).map((e) => [e.from, e.to])).toEqual([[to, def.default], [def.default, to]]);
      expect(must(reset(b.state, def.key, ctx)).entries).toEqual([]);

      // Setting the default explicitly stores nothing.
      expect(must(set(a.state, def.key, def.default, ctx)).state.settings).toEqual({});
      // The CLI's text form parses back to the same value.
      const typed = parseValue(def, def.type === "choice" ? String(to) : def.type === "toggle" ? "on" : String(to));
      expect(typed).toEqual({ ok: true, value: to });
    });
  }

  test("a secret is never stored, set or reset", () => {
    const ctx = makeCtx();
    expect(set(fresh(), "accounts.speech", "sk-1234", ctx)).toMatchObject({ ok: false, code: "secret" });
    expect(reset(fresh(), "accounts.speech", ctx)).toMatchObject({ ok: false, code: "secret" });
    expect(parseValue(schema.def("accounts.speech")!, "x").ok).toBe(false);
  });

  test("invalid values are refused with a reason", () => {
    const ctx = makeCtx();
    expect(set(fresh(), "nope", 1, ctx)).toMatchObject({ ok: false, code: "unknown-key" });
    expect(set(fresh(), "appearance.theme", "purple", ctx)).toMatchObject({ ok: false, code: "invalid-value" });
    expect(set(fresh(), "editor.proseSize", 99, ctx)).toMatchObject({ ok: false, error: "Must be at most 32" });
    expect(set(fresh(), "editor.proseSize", "18", ctx)).toMatchObject({ ok: false, code: "invalid-value" });
    expect(set(fresh(), "editor.focusMode", "on", ctx)).toMatchObject({ ok: false, code: "invalid-value" });
    expect(set(fresh(), "readAloud.skipPrefix", "x".repeat(11), ctx)).toMatchObject({ ok: false, error: "At most 10 characters" });
    expect(parseValue(schema.def("appearance.theme")!, "Dark")).toEqual({ ok: true, value: "dark" });
    expect(parseValue(schema.def("editor.proseSize")!, "")).toMatchObject({ ok: false });
  });

  test("formatValue speaks the user's words", () => {
    expect(formatValue(schema.def("editor.focusMode"), true)).toBe("On");
    expect(formatValue(schema.def("appearance.theme"), "dark")).toBe("Dark");
    expect(formatValue(schema.def("editor.proseSize"), 18)).toBe("18 pt");
    expect(formatValue(schema.def("shortcuts.globalHotkey"), "")).toBe("None");
    expect(formatValue(schema.def("editor.focusMode"), null)).toBe("—");
  });

  test("defineSchema refuses programming mistakes and orders sections", () => {
    expect(schema.sections.map((s) => s.id)).toEqual(["general", "appearance", "shortcuts", "accounts", "editor", "readAloud", "library", "changes", "about"]);
    expect(schema.section("changes")).toMatchObject({ pinned: true, shared: true, label: "Changes" });
    expect(() => defineSchema({ app: "x", settings: [{ key: "a", label: "A", section: "general", type: "toggle", default: false }, { key: "a", label: "A", section: "general", type: "toggle", default: false }] })).toThrow(SchemaError);
    expect(() => defineSchema({ app: "x", settings: [{ key: "a", label: "A", section: "nowhere", type: "toggle", default: false }] })).toThrow(SchemaError);
    expect(() => defineSchema({ app: "x", settings: [{ key: "a", label: "A", section: "changes", type: "toggle", default: false }] })).toThrow(SchemaError);
    expect(() => defineSchema({ app: "x", settings: [{ key: "a", label: "A", section: "general", type: "number", default: 5, max: 3 }] })).toThrow(SchemaError);
    expect(() => defineSchema({ app: "x", settings: [{ key: "a", label: "A", section: "accounts", type: "secret", default: "k" }] })).toThrow(SchemaError);
    expect(() => defineSchema({ app: "X Y", settings: [] })).toThrow(SchemaError);
  });
});

describe("shortcuts", () => {
  test("rebind logs the effective chords and keeps only overrides", () => {
    const ctx = makeCtx();
    const a = must(rebind(fresh(), "rename", "⌥⌘R", ctx));
    expect(a.state.keys).toEqual({ rename: "⌥⌘R" });
    expect(a.entries[0]).toMatchObject({ commandId: "rename", from: "⌘R", to: "⌥⌘R" });
    const b = must(rebind(a.state, "rename", "⌘R", ctx));
    expect(b.state.keys).toEqual({});
    const none = must(rebind(fresh(), "rename", "", ctx));
    expect(none.state.keys).toEqual({ rename: "" });
    expect(chordOf(none.state, "rename", ctx.commands)).toBe("");
    const r = must(reset(none.state, { commandId: "rename" }, ctx));
    expect(r.state.keys).toEqual({});
    expect(r.entries[0]).toMatchObject({ commandId: "rename", from: "", to: "⌘R" });
  });

  test("the injected validator refuses reserved and taken chords; unknown commands are refused", () => {
    const ctx = makeCtx();
    expect(rebind(fresh(), "rename", "⌘Q", ctx)).toMatchObject({ ok: false, code: "invalid-chord", error: "⌘Q is reserved" });
    expect(rebind(fresh(), "rename", "⌘D", ctx)).toMatchObject({ ok: false, error: "⌘D is taken by pin" });
    expect(rebind(fresh(), "ghost", "⌥⌘G", ctx)).toMatchObject({ ok: false, code: "unknown-command" });
    expect(rebind(fresh(), "rename", "\u0001", ctx)).toMatchObject({ ok: false, code: "invalid-chord" });
  });

  test("Swap is one batch judged against the other's new chord", () => {
    const ctx = makeCtx();
    const s = must(rebindMany(fresh(), [{ commandId: "rename", chord: "⌘D" }, { commandId: "pin", chord: "⌘R" }], ctx));
    expect(s.state.keys).toEqual({ rename: "⌘D", pin: "⌘R" });
    expect(s.entries).toHaveLength(2);
    expect(new Set(s.entries.map((e) => e.batch))).toEqual(new Set([s.batch]));
    expect(rebindMany(fresh(), [{ commandId: "rename", chord: "⌘D" }], ctx).ok).toBe(false);
    expect(rebindMany(fresh(), [{ commandId: "rename", chord: "⌥1" }, { commandId: "rename", chord: "⌥2" }], ctx).ok).toBe(false);
  });
});

/** Example Editor-like state: three settings and a shortcut changed. */
function busy(): { state: SettingsState; ctx: ReturnType<typeof makeCtx> } {
  const ctx = makeCtx();
  let state = fresh();
  for (const [k, v] of [["editor.proseSize", 18], ["editor.focusMode", true], ["appearance.theme", "dark"]] as const) state = must(set(state, k, v, ctx)).state;
  state = must(rebind(state, "go-to-heading", "⇧⌘O", ctx)).state;
  return { state, ctx };
}

describe("reset section, reset all, reset entry", () => {
  test("changedFromDefault gives the counts the confirms name", () => {
    const { state } = busy();
    expect(changedFromDefault(state, schema, "editor")).toEqual({ settings: ["editor.proseSize", "editor.focusMode"], keys: [], count: 2 });
    expect(changedFromDefault(state, schema, "shortcuts").count).toBe(1);
    expect(changedFromDefault(state, schema).count).toBe(4);
  });

  test("resetSection resets only that section, in one batch", () => {
    const { state, ctx } = busy();
    const r = must(resetSection(state, "editor", ctx));
    expect(r.entries).toHaveLength(2);
    expect(r.entries.every((e) => e.batch === r.batch && r.batch)).toBe(true);
    expect(r.state.settings).toEqual({ "appearance.theme": "dark" });
    expect(resetSection(state, "nowhere", ctx)).toMatchObject({ ok: false, code: "not-found" });
    expect(must(resetSection(state, "shortcuts", ctx)).state.keys).toEqual({});
  });

  test("resetAll writes as many entries as the count, and nothing is left", () => {
    const { state, ctx } = busy();
    const count = changedFromDefault(state, schema).count;
    const r = must(resetAll(state, ctx));
    expect(r.entries).toHaveLength(count);
    expect(r.state.settings).toEqual({});
    expect(r.state.keys).toEqual({});
    expect(changedFromDefault(r.state, schema).count).toBe(0);
  });

  test("resetEntry puts the earlier value back as a new entry naming the one it reset", () => {
    const { state } = busy();
    const agent = makeCtx({ kind: "agent", name: "Claude Code" }, 5000, "ag");
    const target = lastChange(state, "editor.proseSize")!;
    const r = must(resetEntry(state, target.id, agent));
    expect(valueOf(r.state, schema, "editor.proseSize")).toBe(16);
    expect(r.entries[0]).toMatchObject({ key: "editor.proseSize", from: 18, to: 16, who: { kind: "reset", of: target.id, by: { kind: "agent", name: "Claude Code" } } });
    expect(r.state.changes).toContainEqual(target);
    expect(resetEntry(r.state, target.id, agent)).toMatchObject({ ok: false, code: "already" });
    expect(resetEntry(state, "missing", agent)).toMatchObject({ ok: false, code: "not-found" });
    const k = lastChange(state, { commandId: "go-to-heading" })!;
    expect(must(resetEntry(state, k.id, agent)).state.keys).toEqual({});
  });

  test("a shortcut whose earlier chord is now taken cannot be reset", () => {
    const ctx = makeCtx();
    let state = must(rebind(fresh(), "rename", "⌥⌘R", ctx)).state;
    const e = state.changes[0]!;
    state = must(rebind(state, "pin", "⌘R", ctx)).state;
    expect(resetEntry(state, e.id, ctx)).toMatchObject({ ok: false, code: "not-possible" });
  });
});

describe("undoBatch", () => {
  test("restores exact prior values and is itself one batch", () => {
    const { state, ctx } = busy();
    const before = structuredClone({ settings: state.settings, keys: state.keys });
    const r = must(resetAll(state, ctx));
    const u = must(undoBatch(r.state, r.batch!, ctx));
    expect({ settings: u.state.settings, keys: u.state.keys }).toEqual(before);
    expect(u.entries).toHaveLength(r.entries.length);
    expect(u.entries.every((e) => e.batch === u.batch && e.who.kind === "reset")).toBe(true);
    expect(undoBatch(u.state, r.batch!, ctx)).toMatchObject({ ok: false, code: "already" });
    expect(undoBatch(u.state, "nope", ctx)).toMatchObject({ ok: false, code: "not-found" });
  });

  test("a setting changed again since keeps its later value and is listed", () => {
    const { state, ctx } = busy();
    const r = must(resetAll(state, ctx));
    const later = must(set(r.state, "editor.proseSize", 20, ctx)).state;
    const u = must(undoBatch(later, r.batch!, ctx));
    expect(valueOf(u.state, schema, "editor.proseSize")).toBe(20);
    expect(valueOf(u.state, schema, "appearance.theme")).toBe("dark");
    expect(u.skipped).toEqual([{ key: "editor.proseSize", reason: "Changed again since; its later value is kept" }]);
  });
});

describe("changelog cap", () => {
  const entry = (i: number, batch?: string): ChangeEntry => ({ id: `e${i}`, at: i, key: "k", from: 1, to: 2, who: { kind: "you" }, ...(batch ? { batch } : {}) });

  test("keeps 300 newest and never splits a batch", () => {
    // Newest first: 290 singles, then a batch of 20 straddling the cut, then older singles.
    const list = [...Array.from({ length: 290 }, (_, i) => entry(1000 - i)), ...Array.from({ length: 20 }, (_, i) => entry(500 - i, "B")), ...Array.from({ length: 50 }, (_, i) => entry(100 - i))];
    const out = capChanges(list);
    expect(out.length).toBeLessThanOrEqual(MAX_CHANGES);
    expect(out.filter((e) => e.batch === "B")).toHaveLength(0);
    expect(out).toHaveLength(290);
    const fits = capChanges([...Array.from({ length: 270 }, (_, i) => entry(1000 - i)), ...Array.from({ length: 20 }, (_, i) => entry(500 - i, "B")), ...Array.from({ length: 50 }, (_, i) => entry(100 - i))]);
    expect(fits).toHaveLength(300);
    expect(fits.filter((e) => e.batch === "B")).toHaveLength(20);
  });

  test("a batch larger than the cap is never kept", () => {
    const big = Array.from({ length: 320 }, (_, i) => entry(1000 - i, "BIG"));
    expect(capChanges([...big, entry(1)])).toEqual([entry(1)]);
  });

  test("operations apply the cap", () => {
    const ctx = makeCtx();
    let state = fresh();
    for (let i = 0; i < 320; i++) state = must(set(state, "editor.proseSize", 10 + (i % 20), ctx)).state;
    expect(state.changes).toHaveLength(MAX_CHANGES);
    expect(state.changes[0]!.at).toBeGreaterThan(state.changes[299]!.at);
  });
});

describe("queries for the frames", () => {
  test("filter counts, filters, new since, batch", () => {
    const { state, ctx } = busy();
    const agent = makeCtx({ kind: "agent", name: "Claude Code" }, 9000, "ag");
    const s2 = must(set(state, "library.folder", "~/Elsewhere", agent)).state;
    const s3 = must(resetEntry(s2, lastChange(s2, "editor.focusMode")!.id, ctx)).state;
    expect(changeCounts(s3)).toEqual({ all: 6, you: 5, agent: 1, "app-update": 0, import: 0 });
    expect(filterChanges(s3, { who: "agent" }).map((e) => e.key)).toEqual(["library.folder"]);
    expect(filterChanges(s3, { text: "prose", settings: schema.settings }).map((e) => e.key)).toEqual(["editor.proseSize"]);
    expect(filterChanges(s3, { text: "claude" })).toHaveLength(1);
    expect(newSince(s3, 8999)).toBe(1); // the agent's change; the reset ran on the earlier clock
    const r = must(resetAll(s3, ctx));
    expect(batchOf(r.state, r.batch!)).toMatchObject({ id: r.batch, entries: r.entries, skipped: [] });
  });

  test("search covers label, help, group and section label, in sidebar order", () => {
    expect(searchSettings(schema.settings, schema.sections, "font")).toEqual([{ key: "editor.proseSize", label: "Prose size", section: "editor", sectionLabel: "Editor", group: "Text" }]);
    expect(searchSettings(schema.settings, schema.sections, "editor").map((h) => h.key)).toEqual(["editor.proseSize", "editor.focusMode"]);
    expect(searchSettings(schema.settings, schema.sections, "keychain").map((h) => h.key)).toEqual(["accounts.speech"]);
    expect(searchSettings(schema.settings, schema.sections, "appearance theme light").map((h) => h.section)).toEqual([]);
    expect(searchSettings(schema.settings, schema.sections, "a").map((h) => h.section)[0]).toBe("appearance");
    expect(searchSettings(schema.settings, schema.sections, "  ")).toEqual([]);
  });
});
