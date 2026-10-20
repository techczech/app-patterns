/** Regression tests for the loader's recovery: oversized batches are measured raw, shortcut recovery keeps a maximal subset, the loader's own record survives the cap. */
import { describe, expect, test } from "bun:test";
import { CHANGELOG_KEY, INVALID_SAVED_SETTINGS, INVALID_SAVED_VALUE, MAX_CHANGES, REPAIR_SUMMARY_LIMIT, type ChangeEntry } from "./changes.ts";
import { commands, fresh, makeCtx, must, schema } from "./fixture.test-support.ts";
import { loadState } from "./load.ts";
import { defineSchema, type SettingDef } from "./schema.ts";
import { exportFile, previewImport, applyImport } from "./transfer.ts";
import { undoBatch } from "./operations.ts";
import { valueOf } from "./state.ts";

const loadCtx = { schema, commands, appVersion: "0.31.0", now: () => 0, newId: () => "ld" };
const who = { kind: "app-update", version: "0.31.0" } as const;
const entry = (i: number, batch = "B"): ChangeEntry => ({ id: `e${i}`, at: 5, key: "editor.proseSize", from: 16, to: 18, who: { kind: "you" }, batch });

describe("a saved batch is measured before any entry is filtered", () => {
  test("300 valid entries and one about a secret: the batch of 301 goes whole", () => {
    const secret = { id: "s", at: 5, key: "accounts.speech", from: null, to: "TEST-SECRET", who: { kind: "you" }, batch: "B" };
    const keep: ChangeEntry = { id: "k", at: 1, key: "editor.focusMode", from: false, to: true, who: { kind: "you" } };
    const r = loadState({ ...fresh(), changes: [...Array.from({ length: MAX_CHANGES }, (_, i) => entry(i)), secret, keep] }, loadCtx);
    expect(r.entries).toEqual([{ id: "ld", at: 0, key: CHANGELOG_KEY, from: MAX_CHANGES + 1, to: null, who, note: INVALID_SAVED_VALUE }]);
    expect(r.state.changes).toEqual([...r.entries, keep]);
    expect(JSON.stringify(r)).not.toContain("TEST-SECRET");
    must({ ok: true, state: r.state });
  });

  test("300 valid entries and one malformed: the batch of 301 goes whole", () => {
    const broken = { id: "m", at: 5, key: "editor.proseSize", from: 16, to: 18, batch: "B" }; // no who
    const r = loadState({ ...fresh(), changes: [...Array.from({ length: MAX_CHANGES }, (_, i) => entry(i)), broken] }, loadCtx);
    expect(r.state.changes).toEqual([{ id: "ld", at: 0, key: CHANGELOG_KEY, from: MAX_CHANGES + 1, to: null, who, note: INVALID_SAVED_VALUE }]);
  });

  test("a batch of exactly the cap is kept", () => {
    const r = loadState({ ...fresh(), changes: Array.from({ length: MAX_CHANGES }, (_, i) => entry(i)) }, loadCtx);
    expect(r.entries).toEqual([]);
    expect(r.state.changes).toHaveLength(MAX_CHANGES);
  });
});

describe("shortcut recovery keeps a maximal subset, deterministic by input order", () => {
  const keys = { rename: "⌘D", pin: "⌘R", "insert-link": "⌘D" };

  test("load keeps the Rename/Pin swap and drops Insert link", () => {
    const r = loadState({ ...fresh(), keys }, loadCtx);
    expect(r.state.keys).toEqual({ rename: "⌘D", pin: "⌘R" });
    expect(r.entries.map((e) => e.commandId)).toEqual(["insert-link"]);
    expect(r.entries[0]).toMatchObject({ from: null, to: "⌘K", note: INVALID_SAVED_VALUE });
    must({ ok: true, state: r.state });
  });

  test("import previews the swap and skips Insert link", () => {
    const file = { ...exportFile(fresh(), { appVersion: "0.31.0", hostName: "Mac", now: 0, schema, commands }), keys };
    const p = previewImport(fresh(), file, { schema, commands });
    expect(p.changes.map((c) => c.commandId)).toEqual(["rename", "pin"]);
    expect(p.skipped.map((s) => s.commandId)).toEqual(["insert-link"]);
    expect(must(applyImport(fresh(), p, { file: "f.json" }, makeCtx())).state.keys).toEqual({ rename: "⌘D", pin: "⌘R" });
  });
});

describe("the loader's record of what it did is never pushed out by the cap", () => {
  const many: SettingDef[] = Array.from({ length: MAX_CHANGES }, (_, i) => ({ key: `t.${i}`, label: `T${i}`, section: "general", type: "toggle", default: false }));
  const big = defineSchema({ app: "editorexample", settings: many });
  const ctx = { ...loadCtx, schema: big };

  test("a dropped batch of 301 and 300 invalid toggles: the marker and one summary are kept", () => {
    const settings = Object.fromEntries(many.map((d) => [d.key, "yes"]));
    const r = loadState({ ...fresh(), settings, changes: Array.from({ length: MAX_CHANGES + 1 }, (_, i) => entry(i)) }, ctx);
    const marker = r.state.changes.find((e) => e.note === INVALID_SAVED_VALUE);
    const summary = r.state.changes.find((e) => e.note === INVALID_SAVED_SETTINGS);
    expect(marker).toMatchObject({ key: CHANGELOG_KEY, from: MAX_CHANGES + 1, to: null, who });
    expect(summary).toMatchObject({ key: CHANGELOG_KEY, from: MAX_CHANGES, to: null, who });
    expect(r.state.changes).toEqual(r.entries);
    expect(r.entries).toHaveLength(2);
    must({ ok: true, state: r.state }, big);
  });

  test("the loader's entries push out the oldest history, never its own", () => {
    const old = Array.from({ length: MAX_CHANGES }, (_, i): ChangeEntry => ({ id: `o${i}`, at: 1, key: "t.0", from: false, to: true, who: { kind: "you" } }));
    const r = loadState({ ...fresh(), settings: { "t.1": "yes", "t.2": "no" }, changes: old }, ctx);
    expect(r.entries).toHaveLength(2);
    expect(r.state.changes).toHaveLength(MAX_CHANGES);
    expect(r.state.changes.slice(0, 2)).toEqual(r.entries);
    expect(r.state.changes.at(-1)!.id).toBe(`o${MAX_CHANGES - 3}`);
  });

  test("twenty invalid values of a kind are logged one by one", () => {
    const settings = Object.fromEntries(many.slice(0, 20).map((d) => [d.key, "yes"]));
    const r = loadState({ ...fresh(), settings }, ctx);
    expect(r.entries).toHaveLength(20);
    expect(r.entries.every((e) => e.note === INVALID_SAVED_VALUE && e.key !== CHANGELOG_KEY)).toBe(true);
  });
});

describe("a repair summary names what it repaired, so undo keeps the repair", () => {
  const nums: SettingDef[] = Array.from({ length: 30 }, (_, i) => ({ key: `n.${i}`, label: `N${i}`, section: "general", type: "number", default: 0, min: 0, max: 10 }));
  const secretDef: SettingDef = { key: "s.key", label: "Key", section: "general", type: "secret", default: null };
  const numSchema = defineSchema({ app: "editorexample", settings: [...nums, secretDef] });
  const ctx = { ...makeCtx(), schema: numSchema };
  const older: ChangeEntry[] = [
    { id: "a1", at: 1, key: "n.0", from: 2, to: 1, who: { kind: "you" }, batch: "A" },
    { id: "a2", at: 1, key: "n.29", from: 2, to: 1, who: { kind: "you" }, batch: "A" },
  ];
  const saved = (bad: number) => ({ ...fresh(), settings: { ...Object.fromEntries(nums.slice(0, bad).map((d) => [d.key, "x"])), "n.29": 1 }, changes: older });

  for (const bad of [20, 21]) {
    test(`${bad} repairs: undo of the older batch keeps the repaired value`, () => {
      const r = loadState(saved(bad), { ...loadCtx, schema: numSchema });
      if (bad > REPAIR_SUMMARY_LIMIT) {
        const summary = r.entries.find((e) => e.note === INVALID_SAVED_SETTINGS)!;
        expect(summary.targets).toEqual(nums.slice(0, bad).map((d) => d.key).sort());
      }
      const u = must(undoBatch(r.state, "A", ctx), numSchema);
      expect(valueOf(u.state, numSchema, "n.0")).toBe(0);
      expect(valueOf(u.state, numSchema, "n.29")).toBe(2);
      expect(u.skipped).toEqual([{ key: "n.0", reason: "Changed again since; its later value is kept" }]);
    });
  }

  test("targets survive reload; non-strings, unknown keys and secrets are dropped", () => {
    const r = loadState(saved(21), { ...loadCtx, schema: numSchema });
    must({ ok: true, state: r.state }, numSchema);
    const summary = { id: "y", at: 1, key: CHANGELOG_KEY, from: 3, to: null, who, note: INVALID_SAVED_SETTINGS, targets: ["n.3", 7, "s.key", "ghost", "n.1"] };
    const e = loadState({ ...fresh(), changes: [summary] }, { ...loadCtx, schema: numSchema });
    expect(e.state.changes[0]!.targets).toEqual(["n.1", "n.3"]);
    expect(JSON.stringify(e.state)).not.toContain("s.key");
  });
});

describe("a load that leaves anything out is lossy", () => {
  const st = (): Record<string, unknown> => JSON.parse(JSON.stringify(fresh()));
  const lossy = (raw: unknown) => loadState(raw, loadCtx).lossy;
  const kept: ChangeEntry = { id: "k", at: 1, key: "editor.proseSize", from: 16, to: 18, who: { kind: "you" } };

  test("a file exactly as written, in any property order, is not", () => {
    expect(lossy(st())).toBe(false);
    const full = { ...st(), settings: { "editor.proseSize": 18 }, changes: [kept] };
    expect(lossy(full)).toBe(false);
    const reordered = { changes: [{ who: { kind: "you" }, to: 18, from: 16, key: "editor.proseSize", at: 1, id: "k" }], keys: {}, settings: { "editor.proseSize": 18 }, app: "editorexample", version: 2, format: "bridle-settings" };
    expect(lossy(reordered)).toBe(false);
  });

  test("every kind of drop or change is, whatever it is named", () => {
    for (const extra of [
      { changes: [{ ...kept, toOrigin: "bad" }] },
      { changes: [{ ...kept, batch: 5 }] },
      { changes: [{ ...kept, note: "NOPE" }] },
      { changes: [{ ...kept, extra: "x" }] },
      { changes: [{ ...kept, who: { kind: "you", token: "x" } }] },
      { changes: [[{ key: "accounts.speech", to: "x" }]] },
      { changes: { "0": kept } },
      { settings: { ghost: { "accounts.speech": "x" } } },
      { settings: { ghost: "sk-ant-x" } },
      { settings: { "editor.proseSize": 16 } }, // the default: not kept
      { settings: { "editor.proseSize": 999 } },
      { settings: ["x"] },
      { keys: { ghost: { "accounts.speech": "x" } } },
      { keys: "x" },
      { backup: "sk-ant-x" },
    ]) expect([extra, lossy({ ...st(), ...extra })]).toEqual([extra, true]);
  });

  test("a huge array is compared without overflowing the stack", () => {
    expect(lossy({ ...st(), changes: Array.from({ length: 150_000 }, () => 0) })).toBe(true);
    expect(lossy({ ...st(), junk: Array.from({ length: 150_000 }, () => [0]) })).toBe(true);
  });
});
