import { describe, expect, test } from "bun:test";
import { canonChord } from "./chords.ts";
import { FIXTURE_DEFS, fixture } from "./fixture.ts";
import { defineRegistry, type CommandDef } from "./registry.ts";
import { RESERVED_ESTATE, RESERVED_SYSTEM } from "./reserved.ts";

const r = fixture;

const base = { group: "G", label: "L", icon: "x" } as const;

describe("registry definition", () => {
  test("has unique ids, canonical chords and no two commands on one default chord", () => {
    expect(new Set(r.defs.map((c) => c.id)).size).toBe(r.defs.length);
    const keys = r.defs.map((c) => c.key).filter(Boolean);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(canonChord(k)).toBe(k);
  });
  test("refuses defects at definition time", () => {
    expect(() => defineRegistry([{ ...base, id: "a", key: "" }, { ...base, id: "a", key: "" }])).toThrow(/Duplicate/);
    expect(() => defineRegistry([{ ...base, id: "a", key: "⌘J" }, { ...base, id: "b", key: "⌘J" }])).toThrow(/share the default chord/);
    expect(() => defineRegistry([{ ...base, id: "a", key: "⌘j" }])).toThrow(/invalid default chord/);
    expect(() => defineRegistry([{ ...base, id: "a", key: "⌘Q" }])).toThrow(/reserved/);
    expect(() => defineRegistry([{ ...base, id: "a", key: "⌘K" }])).toThrow(/reserved/);
    expect(() => defineRegistry([{ ...base, id: "a", key: "", noMenu: true }])).toThrow(/noMenuReason/);
    expect(() => defineRegistry([{ ...base, id: "a", key: "⌘K", fixed: true }])).not.toThrow();
    for (const id of ["__proto__", "Has Upper", "1abc", "", "a_b"]) expect(() => defineRegistry([{ ...base, id, key: "⌘J" }]), id).toThrow(/must match/);
  });
  test("carries the estate and system reserved sets", () => {
    for (const c of ["⌘⇧P", "⌘⇧K", "⌘K", "⌘P", "⌘F", "⌘⇧F", "⌘,", "⌘/"]) expect(RESERVED_ESTATE[c]).toBeTruthy();
    for (const c of ["⌘Q", "⌘W", "⌘H", "⌘M", "⌘C", "⌘X", "⌘V", "⌘A", "⌘Z", "⌘⇧Z"]) expect(RESERVED_SYSTEM[c]).toBeTruthy();
    expect(r.reserved["⌘F"]).toBe("Find in this item");
    expect(r.reserved["⌘⇧,"]).toBe("Change the shortcut");
  });
});

describe("bindings", () => {
  test("resolve a chord to its command and follow overrides", () => {
    const b = r.bindingsOf({ rename: "⌘⌥R", pin: "" });
    expect(r.commandForChord(b, "⌘⌥R")).toBe("rename");
    expect(r.commandForChord(b, "⌘R")).toBeNull();
    expect(b.pin).toBe("");
    expect(r.commandForChord(b, "⌘D")).toBeNull();
    expect(r.commandForChord(r.bindingsOf(), "⌘⇧P")).toBe("palette");
    expect(r.commandForChord(r.bindingsOf(), "")).toBeNull();
  });
  test("ignore an override of a fixed command", () => {
    expect(r.bindingsOf({ palette: "⌘⌥P" }).palette).toBe("⌘⇧P");
  });
  test("know only typing commands may run while typing", () => {
    expect(r.runsWhileTyping("cheat")).toBe(true);
    for (const id of ["rename", "pin", "undo", "next", "open", "nope"]) expect(r.runsWhileTyping(id)).toBe(false);
  });
});

describe("rebinding outcomes", () => {
  const b = r.bindingsOf();
  test("ok and same", () => {
    expect(r.checkRebind(b, "rename", "⌘⌥R")).toEqual({ kind: "ok" });
    expect(r.checkRebind(b, "rename", "⌘R")).toEqual({ kind: "same" });
    expect(r.checkRebind(b, "rename", "")).toEqual({ kind: "ok" });
    expect(r.checkRebind(b, "export", "")).toEqual({ kind: "same" });
  });
  test("taken names the holder", () => {
    expect(r.checkRebind(b, "rename", "⌘D")).toEqual({ kind: "taken", by: "pin" });
    expect(r.rebindMessage({ kind: "taken", by: "pin" }, "⌘D")).toBe("⌘D is already used by “Pin or unpin”");
  });
  test("reserved estate, system and fixed chords are refused", () => {
    expect(r.checkRebind(b, "rename", "⌘⇧P")).toEqual({ kind: "reserved", by: "Command palette" });
    expect(r.checkRebind(b, "rename", "⌘F")).toMatchObject({ kind: "reserved" });
    expect(r.checkRebind(b, "rename", "⌘K")).toMatchObject({ kind: "reserved" }); // estate chord nobody in the fixture holds
    expect(r.checkRebind(b, "rename", "⌘Q")).toEqual({ kind: "reserved", by: "Quit" });
    expect(r.checkRebind(b, "rename", "⌘⇧Z")).toEqual({ kind: "reserved", by: "Redo" });
    expect(r.rebindMessage({ kind: "reserved", by: "Quit" }, "⌘Q")).toContain("Quit");
  });
  test("fixed commands and unknown ids cannot be rebound", () => {
    expect(r.checkRebind(b, "palette", "⌘⌥P")).toEqual({ kind: "fixed" });
    expect(r.checkRebind(b, "cheat", "")).toEqual({ kind: "fixed" });
    expect(r.checkRebind(b, "nope", "⌘J")).toEqual({ kind: "fixed" });
  });
  test("bare and invalid", () => {
    expect(r.checkRebind(b, "rename", "R")).toEqual({ kind: "bare" });
    expect(r.checkRebind(b, "rename", "↓")).toEqual({ kind: "bare" });
    expect(r.checkRebind(b, "rename", "⌘Hello")).toEqual({ kind: "invalid" });
    expect(r.rebindMessage({ kind: "ok" }, "⌘J")).toBe("");
  });
  test("an ok outcome applied leaves no collision", () => {
    const next = r.bindingsOf({ rename: "⌘⌥R" });
    const keys = Object.values(next).filter(Boolean);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("palette and cheat sheet", () => {
  test("palette lists all but hidden, with the reason a command is unavailable", () => {
    const rows = r.paletteList({ selected: false });
    expect(rows.length).toBe(r.defs.length - 1);
    expect(rows.find((x) => x.def.id === "rebind")).toBeUndefined();
    expect(rows.find((x) => x.def.id === "rename")?.reason).toBe("select an item first");
    expect(r.paletteList({ selected: true }).find((x) => x.def.id === "rename")?.reason).toBeNull();
    expect(rows.find((x) => x.def.id === "palette")?.reason).toBeNull();
  });
  test("palette filters by every word in the label or group", () => {
    const ids = (q: string) => r.paletteList({ selected: true }, q).map((x) => x.def.id);
    expect(ids("zoom in")).toEqual(["zoom-in"]);
    expect(ids("item pin")).toEqual(["pin"]);
    expect(ids("zzz")).toEqual([]);
  });
  test("cheat sheet groups commands that have a chord, follows overrides, skips hidden", () => {
    const sheet = r.cheatSheet(r.bindingsOf({ pin: "", export: "⌘⌥E" }));
    expect(sheet.map((g) => g.group)).toEqual(["Find", "View", "Item", "App"]);
    const item = sheet.find((g) => g.group === "Item")!;
    expect(item.entries).toEqual([
      { id: "rename", label: "Rename", chord: "⌘R" },
      { id: "export", label: "Export", chord: "⌘⌥E" },
    ]);
    expect(sheet.flatMap((g) => g.entries).find((e) => e.id === "rebind")).toBeUndefined();
  });
});

describe("effective bindings from saved overrides", () => {
  test("an override on a reserved chord is dropped, the default kept, and reported", () => {
    const { bindings, rejected } = r.resolveBindings({ rename: "⌘Q" });
    expect(bindings.rename).toBe("⌘R");
    expect(r.commandForChord(bindings, "⌘Q")).toBeNull();
    expect(rejected).toEqual([{ commandId: "rename", chord: "⌘Q", reason: "reserved" }]);
  });
  test("an override that collides is dropped and no chord has two holders", () => {
    const { bindings, rejected } = r.resolveBindings({ rename: "⌘D", pin: "⌘D" });
    const held = Object.values(bindings).filter(Boolean);
    expect(new Set(held).size).toBe(held.length);
    expect(rejected.map((x) => x.reason)).toEqual(["taken"]);
    expect(bindings.rename).toBe("⌘D"); // first in definition order wins
    expect(bindings.pin).toBe(""); // refused, and its default is now held by rename
  });
  test("an override onto another command's untouched default is refused", () => {
    const { bindings, rejected } = r.resolveBindings({ rename: "⌘D" });
    expect(bindings).toMatchObject({ rename: "⌘R", pin: "⌘D" });
    expect(rejected).toEqual([{ commandId: "rename", chord: "⌘D", reason: "taken" }]);
  });
  test("two commands can swap chords", () => {
    const { bindings, rejected } = r.resolveBindings({ rename: "⌘D", pin: "⌘R" });
    expect(bindings).toMatchObject({ rename: "⌘D", pin: "⌘R" });
    expect(rejected).toEqual([]);
  });
  test("invalid, bare, unknown and fixed overrides are reported; nothing throws", () => {
    const { bindings, rejected } = r.resolveBindings({ rename: "⌘Hello", pin: "D", ghost: "⌘J", palette: "⌘J", export: 5 as unknown as string });
    expect(rejected.map((x) => `${x.commandId}:${x.reason}`).sort()).toEqual(["export:invalid", "ghost:unknown", "palette:fixed", "pin:bare", "rename:invalid"]);
    expect(bindings).toMatchObject({ rename: "⌘R", pin: "⌘D", palette: "⌘⇧P", export: "" });
  });
  test("a removed shortcut is not a rejection", () => {
    expect(r.resolveBindings({ pin: "" })).toEqual({ bindings: expect.objectContaining({ pin: "" }), rejected: [] });
  });
  test("ids from outside never reach inherited properties", () => {
    const b = r.bindingsOf({ __proto__: "⌘J", constructor: "⌘J" } as never);
    expect(r.commandForChord(b, "⌘J")).toBeNull();
    expect(r.commandForChord({}, "⌘J")).toBeNull();
    const c = defineRegistry<"G", void>([{ group: "G", label: "C", icon: "x", id: "constructor", key: "⌘J" }]);
    expect(c.commandForChord(c.bindingsOf(), "⌘J")).toBe("constructor");
    expect(c.commandForChord({}, "⌘J")).toBeNull();
    expect(r.checkRebind({}, "rename", "⌘J")).toEqual({ kind: "ok" });
    expect(r.checkRebind(b, "rename", "⌘J")).toEqual({ kind: "ok" });
    expect(r.resolveBindings(JSON.parse('{"__proto__":"⌘J"}')).rejected).toEqual([{ commandId: "__proto__", chord: "⌘J", reason: "unknown" }]);
  });
});

describe("hostile saved values", () => {
  test("a modifier-only or blank-but-not-empty override is invalid and keeps the default; only exactly empty removes", () => {
    for (const raw of ["⌘", " ", "⌘⇧"]) {
      const { bindings, rejected } = r.resolveBindings({ rename: raw });
      expect(bindings.rename, raw).toBe("⌘R");
      expect(rejected, raw).toEqual([{ commandId: "rename", chord: raw, reason: "invalid" }]);
    }
    expect(r.resolveBindings({ rename: "" })).toEqual({ bindings: expect.objectContaining({ rename: "" }), rejected: [] });
  });
  test("reporting never throws on arbitrary JSON", () => {
    for (const json of ['{"rename":{"toString":null}}', '{"rename":[1,2]}', '{"rename":null}', '{"ghost":{"toString":null}}', '{"palette":{"toString":null}}', `{"rename":${JSON.stringify({ a: "x".repeat(500) })}}`]) {
      const res = r.resolveBindings(JSON.parse(json));
      expect(res.rejected.length).toBe(1);
      expect(res.rejected[0]!.chord.length).toBeLessThanOrEqual(80);
    }
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    expect(r.resolveBindings({ rename: cyclic as never }).rejected[0]!.chord).toBe("object");
  });
});

describe("definitions are copied", () => {
  test("changing the caller's array or objects afterwards does not change the registry", () => {
    const defs: CommandDef<string, void>[] = [{ ...base, id: "one", key: "⌘J" }];
    const x = defineRegistry<string, void>(defs);
    defs.push({ ...base, id: "two", key: "⌘L" });
    defs[0]!.label = "changed";
    expect(x.byId("two")).toBeUndefined();
    expect(x.isCommandId("two")).toBe(false);
    expect(x.byId("one")!.label).toBe("L");
    expect(Object.isFrozen(x.defs)).toBe(true);
    expect(Object.isFrozen(x.defs[0])).toBe(true);
  });
});

describe("scopes", () => {
  const def = (id: string, key: string, scope?: string) => ({ id, group: "G", label: id, key, icon: "x", ...(scope ? { scope } : {}) });
  test("the same default chord is allowed in different scopes, rejected within one", () => {
    expect(() => defineRegistry([def("a", "⌘J"), def("b", "⌘J", "list")])).not.toThrow();
    expect(() => defineRegistry([def("a", "⌘J", "list"), def("b", "⌘J", "tree")])).not.toThrow();
    expect(() => defineRegistry([def("a", "⌘J", "list"), def("b", "⌘J", "list")])).toThrow(/share the default chord/);
    expect(() => defineRegistry([def("a", "⌘J"), def("b", "⌘J")])).toThrow(/share the default chord/);
  });
  test("reserved chords stay reserved in a named scope; a scope named global is refused", () => {
    expect(() => defineRegistry([def("a", "⌘Q", "list")])).toThrow(/reserved/);
    expect(() => defineRegistry([def("a", "⌘J", "global")])).toThrow(/invalid scope/);
  });
  test("bare overrides are accepted for scoped commands only", () => {
    const r = defineRegistry([def("g", "⌘J"), def("s", "⌘L", "list")]);
    expect(r.checkRebind(r.bindingsOf(), "s", "X")).toEqual({ kind: "ok" });
    expect(r.checkRebind(r.bindingsOf(), "g", "X")).toEqual({ kind: "bare" });
    const { bindings, rejected } = r.resolveBindings({ s: "X", g: "Y" });
    expect(bindings.s).toBe("X");
    expect(bindings.g).toBe("⌘J");
    expect(rejected.map((x) => `${x.commandId}:${x.reason}`)).toEqual(["g:bare"]);
    expect(r.checkRebind(r.bindingsOf(), "s", "⌘Q")).toEqual({ kind: "reserved", by: "Quit" });
  });
  test("collisions are checked within a scope; a scoped chord may shadow a global one", () => {
    const r = defineRegistry([def("g", "F5"), def("s1", "⌦", "list"), def("s2", "", "list"), def("s3", "", "tree")]);
    const b = r.bindingsOf();
    expect(r.checkRebind(b, "s2", "⌦")).toEqual({ kind: "taken", by: "s1" });
    expect(r.checkRebind(b, "s3", "⌦")).toEqual({ kind: "ok" });
    expect(r.checkRebind(b, "s2", "F5")).toEqual({ kind: "ok" });
    expect(r.commandForChord({ ...b, s2: "F5" }, "F5")).toBe("g");
    expect(r.commandForChord({ ...b, s2: "F5" }, "F5", "list")).toBe("s2");
    expect(r.commandForChord(b, "⌦")).toBeNull();
    expect(r.commandForChord(b, "⌦", "list")).toBe("s1");
  });
  test("a typing command cannot take a bare override", () => {
    const r = defineRegistry([{ ...def("s", "⌘J", "list"), typing: true }]);
    expect(r.checkRebind(r.bindingsOf(), "s", "X")).toEqual({ kind: "typing" });
    expect(r.rebindMessage({ kind: "typing" }, "X")).toMatch(/also runs while typing/);
    const { bindings, rejected } = r.resolveBindings({ s: "X" });
    expect(bindings.s).toBe("⌘J");
    expect(rejected.map((x) => x.reason)).toEqual(["typing"]);
    expect(r.checkRebind(r.bindingsOf(), "s", "⌘X")).not.toEqual({ kind: "typing" }); // a modified chord is fine
  });
  test("scope is validated for unbound commands too, and one rule serves rebind and lookup", () => {
    for (const scope of ["global", "", " list"]) expect(() => defineRegistry([{ ...def("u", ""), scope }])).toThrow(/invalid scope/);
    expect(() => defineRegistry([{ ...def("u", ""), scope: "global" }])).toThrow(/invalid scope/);
    expect(() => defineRegistry([{ ...def("u", ""), scope: "" }])).toThrow(/invalid scope/);
    const r = defineRegistry([def("g", "")]);
    expect(r.checkRebind(r.bindingsOf(), "g", "X")).toEqual({ kind: "bare" });
    expect(r.commandForChord({ g: "X" }, "X", " global")).toBe("g");
  });
});


describe("rebindable estate defaults", () => {
  const estate = [
    ["palette", "⌘⇧P", "⌘⌥P"], ["search", "⌘⇧F", "⌘⌥S"], ["find", "⌘F", "⌘⌥F"],
    ["switcher", "⌘⇧K", "⌘⌥J"], ["context", "⌘K", "⌘⌥K"], ["inspector", "⌘P", "⌘⌥I"],
    ["rebind", "⌘⇧,", "⌘⌥,"], ["settings", "⌘,", "⌘⌥G"], ["cheat", "⌘/", "⌘⌥/"],
  ] as const;
  const input: CommandDef<"G">[] = estate.map(([id, key]) => ({ ...base, id, label: id, key, fixed: true, typing: true }));
  const create = () => defineRegistry(input, { rebindableEstateDefaults: true });

  test("all nine estate bindings move, survive saved overrides and return to their own default", () => {
    const registry = create();
    const overrides = Object.fromEntries(estate.map(([id, , chord]) => [id, chord]));
    const { bindings, rejected } = registry.resolveBindings(JSON.parse(JSON.stringify(overrides)));
    expect(rejected).toEqual([]);
    for (const [id, key, custom] of estate) {
      expect(bindings[id]).toBe(custom);
      expect(registry.commandForChord(bindings, custom)).toBe(id);
      expect(registry.commandForChord(bindings, key)).toBeNull();
      expect(registry.checkRebind(bindings, id, key)).toEqual({ kind: "ok" });
      expect(registry.byId(id)?.fixed).toBeUndefined();
      expect(registry.overlayIds.has(id)).toBe(true);
    }
    expect(input.every((d) => d.fixed)).toBe(true);
    expect(Object.isFrozen(registry.defs[0])).toBe(true);
    expect(registry.cheatSheet(bindings).flatMap((g) => g.entries).filter((e) => overrides[e.id]).map((e) => e.chord).sort()).toEqual(Object.values(overrides).sort());
  });

  test("freed default chords keep their meanings in every scope, even for fixed intruders", () => {
    const registry = defineRegistry([...input, { ...base, id: "other", key: "⌘J", scope: "list" }], { rebindableEstateDefaults: true });
    const bindings = registry.bindingsOf(Object.fromEntries(estate.map(([id]) => [id, ""])));
    for (const [id, key] of estate) {
      expect(bindings[id]).toBe("");
      expect(registry.checkRebind(bindings, "other", key)).toMatchObject({ kind: "reserved" });
      expect(registry.resolveBindings({ [id]: "", other: key }).rejected).toContainEqual({ commandId: "other", chord: key, reason: "reserved" });
      expect(() => defineRegistry([...input, { ...base, id: "impostor", key, scope: "list", fixed: true }], { rebindableEstateDefaults: true })).toThrow(/reserved/);
    }
    expect(registry.checkRebind(bindings, "other", "⌘Q")).toMatchObject({ kind: "reserved" });
  });

  test("non-fixed estate defaults may claim their meaning only with opt-in, and collisions still refuse", () => {
    const plain = [{ ...base, id: "palette", key: "⌘⇧P" }];
    expect(() => defineRegistry(plain)).toThrow(/reserved/);
    const registry = defineRegistry([...plain, { ...base, id: "other", key: "⌘J" }], { rebindableEstateDefaults: true });
    expect(registry.checkRebind(registry.bindingsOf(), "palette", "⌘J")).toEqual({ kind: "taken", by: "other" });
    expect(registry.resolveBindings({ palette: "⌘J" }).bindings.palette).toBe("⌘⇧P");
  });

  test("legacy callers and explicitly fixed non-estate commands keep fixed behaviour", () => {
    const legacy = defineRegistry(input);
    expect(legacy.resolveBindings({ palette: "⌘⌥P", settings: "⌘⌥G" }).rejected.map((r) => r.reason)).toEqual(["fixed", "fixed"]);
    const registry = defineRegistry([{ ...base, id: "fixed-action", key: "⌘J", fixed: true }, { ...base, id: "other", key: "" }], { rebindableEstateDefaults: true });
    expect(registry.checkRebind(registry.bindingsOf(), "fixed-action", "⌘L")).toEqual({ kind: "fixed" });
    expect(registry.checkRebind(registry.bindingsOf(), "other", "⌘J")).toEqual({ kind: "reserved", by: "L" });
  });
});

describe("platform binding restrictions", () => {
  const registry = defineRegistry([{ ...base, id: "refresh", key: "⌘R" }]);
  const refused: [string, RegExp][] = [["⌘⌃⌥⇧R", /four modifiers|Raycast/], ...["←", "→", "↑", "↓"].map((arrow): [string, RegExp] => [`⌃${arrow}`, /Mission Control|Spaces/])];
  for (const [chord, message] of refused) {
    test(`refuses ${chord} at definition, rebind and saved override boundaries`, () => {
      for (const fixed of [undefined, true] as const) expect(() => defineRegistry([{ ...base, id: "refresh", key: chord, fixed }])).toThrow(message);
      const check = registry.checkRebind(registry.bindingsOf(), "refresh", chord);
      expect(check).toMatchObject({ kind: "platform" });
      expect(registry.rebindMessage(check, chord)).toMatch(message);
      expect(registry.resolveBindings({ refresh: chord })).toEqual({ bindings: expect.objectContaining({ refresh: "⌘R" }), rejected: [{ commandId: "refresh", chord, reason: "platform" }] });
    });
  }
  test("keeps Control+Command structural arrows and their subtree variants available", () => {
    for (const arrow of ["←", "→", "↑", "↓"]) for (const chord of [`⌘⌃${arrow}`, `⌘⌃⇧${arrow}`, `⌃⌥${arrow}`]) {
      expect(() => defineRegistry([{ ...base, id: "structure", key: chord }])).not.toThrow();
      expect(registry.checkRebind(registry.bindingsOf(), "refresh", chord)).toEqual({ kind: "ok" });
      expect(registry.resolveBindings({ refresh: chord }).rejected).toEqual([]);
    }
  });
});
