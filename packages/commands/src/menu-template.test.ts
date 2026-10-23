import { describe, expect, test } from "bun:test";
import { defineRegistry, FRAME_COMMAND_IDS } from "./registry.ts";
import { fixture } from "./fixture.ts";
import { buildMenuTemplate, validateMenuCoverage, type MenuDecl, type MenuItem } from "./menu-template.ts";
import type { FixtureCtx, FixtureGroup } from "./fixture.ts";

const r = fixture;

const menus: MenuDecl<FixtureGroup>[] = [
  { label: "Go", groups: ["Find"] },
  { label: "View", groups: ["View"] },
  { label: "Item", groups: ["Item"] },
];
const items = (t: MenuItem[]) => t.flatMap((m) => m.submenu ?? []);
const commands = (t: MenuItem[]) => items(t).filter((i) => i.label && i.click);
const build = (overrides = {}, run: (id: string) => void = () => undefined, m = menus) =>
  buildMenuTemplate<FixtureGroup, FixtureCtx>({ appName: "Demo", registry: r, menus: m, bindings: r.bindingsOf(overrides), run, ctx: { selected: true } });

describe("menu coverage", () => {
  test("finds nothing uncovered when every non-noMenu group is declared", () => {
    expect(validateMenuCoverage(r, menus)).toEqual([]);
  });
  test("lists the commands of an undeclared group, never noMenu or frame commands", () => {
    expect(validateMenuCoverage(r, [{ label: "Go", groups: ["Find"] }, { label: "View", groups: ["View"] }])).toEqual(["rename", "pin", "export"]);
    expect(validateMenuCoverage(r, [])).not.toContain("undo");
    expect(validateMenuCoverage(r, [])).not.toContain("settings");
  });
  test("build refuses an uncovered command, an unknown group and a group in two menus", () => {
    expect(() => build({}, () => undefined, menus.slice(0, 2))).toThrow(/no menu/);
    expect(() => build({}, () => undefined, [...menus, { label: "Again", groups: ["Item"] }])).toThrow(/exactly one menu/);
    expect(() => build({}, () => undefined, [...menus, { label: "Bad", groups: ["Nope" as FixtureGroup] }])).toThrow(/unknown group/);
  });
});

describe("menu template", () => {
  test("has the fixed frame in order", () => {
    expect(build().map((m) => m.label)).toEqual(["Demo", "Edit", "View", "Go", "Item", "Window", "Help"]);
    const app = build()[0]!.submenu!;
    expect(app.map((i) => i.label ?? i.role ?? i.type)).toEqual([
      "about", "separator", "Settings…", "Export Settings…", "Import Settings…", "separator", "hide", "hideOthers", "unhide", "separator", "quit",
    ]);
  });
  test("lands every non-noMenu command exactly once, and runs it", () => {
    const ran: string[] = [];
    const t = build({}, (id) => ran.push(id));
    const frame = new Set(["Settings…", "Export Settings…", "Import Settings…", "Cheat sheet (app wording)"]);
    const grouped = commands(t).filter((i) => !frame.has(i.label!));
    const want = r.defs.filter((d) => !d.noMenu && !FRAME_COMMAND_IDS.includes(d.id)).map((d) => d.label).sort();
    expect(grouped.map((i) => i.label).sort()).toEqual(want);
    commands(t).forEach((i) => i.click!());
    expect(ran.sort()).toEqual(r.defs.filter((d) => !d.noMenu).map((d) => d.id).sort());
    for (const id of ran) expect(r.isCommandId(id)).toBe(true);
  });
  test("shows the chord but never registers it", () => {
    for (const i of commands(build())) if (i.accelerator) expect(i.registerAccelerator).toBe(false);
  });
  test("follows a rebinding and shows no accelerator for a removed shortcut or a bare key", () => {
    const t = build({ rename: "⌘⌥R", pin: "" });
    const find = (l: string) => commands(t).find((i) => i.label === l)!;
    expect(find("Rename").accelerator).toBe("Cmd+Alt+R");
    expect(find("Pin or unpin").accelerator).toBeUndefined();
    expect(find("Command palette").accelerator).toBe("Cmd+Shift+P");
    expect(find("Settings…").accelerator).toBe("Cmd+,");
    expect(find("Cheat sheet (app wording)").accelerator).toBe("Cmd+/");
  });
  test("adds declared Edit and Help groups and app items to the frame menus", () => {
    const t = buildMenuTemplate<FixtureGroup, FixtureCtx>({
      appName: "Demo", registry: r, bindings: r.bindingsOf(), run: () => undefined, ctx: { selected: true },
      menus: [{ label: "Go", groups: ["Find", "View"] }, { label: "Edit", groups: ["Item"] }],
      appItems: { app: [{ label: "Check for updates…" }], help: [{ label: "Demo help" }] },
    });
    const labelsOf = (m: string) => t.find((x) => x.label === m)!.submenu!.map((i) => i.label ?? i.role);
    expect(labelsOf("Edit")).toEqual(["undo", "redo", undefined, "cut", "copy", "paste", "selectAll", undefined, "Rename", "Pin or unpin", "Export"]);
    expect(labelsOf("Demo")).toContain("Check for updates…");
    expect(labelsOf("Help")).toEqual(["Cheat sheet (app wording)", "Demo help"]);
  });

  test("frame commands are always present, even in a registry that does not mention them", () => {
    const bare = defineRegistry<"A", void>([{ id: "one", group: "A", label: "One", key: "", icon: "x" }]);
    const t = buildMenuTemplate({ appName: "Bare", registry: bare, menus: [{ label: "A", groups: ["A"] }], bindings: bare.bindingsOf(), run: () => undefined, ctx: undefined });
    const labels = commands(t).map((i) => i.label);
    expect(labels).toEqual(expect.arrayContaining(["Settings…", "Export Settings…", "Import Settings…", "Keyboard cheat sheet"]));
    expect(commands(t).find((i) => i.label === "Settings…")!.accelerator).toBe("Cmd+,");
    expect(commands(t).find((i) => i.label === "Keyboard cheat sheet")!.accelerator).toBe("Cmd+/");
    expect(bare.isCommandId("export-settings") && bare.isCommandId("import-settings")).toBe(true);
    expect(bare.checkRebind(bare.bindingsOf(), "settings", "⌘J")).toEqual({ kind: "fixed" });
  });
  test("an app cannot rekey a frame command, only relabel it", () => {
    const x = defineRegistry<"A", void>([{ id: "settings", group: "A", label: "Preferences…", key: "⌘J", icon: "cog" }]);
    expect(x.byId("settings")).toMatchObject({ label: "Preferences…", key: "⌘,", fixed: true });
  });
  test("items follow availability when a context is given, and are all enabled without one", () => {
    const find = (t: MenuItem[], l: string) => commands(t).find((i) => i.label === l)!;
    const mk = (ctx: FixtureCtx) => buildMenuTemplate<FixtureGroup, FixtureCtx>({ appName: "Demo", registry: r, menus, bindings: r.bindingsOf(), run: () => undefined, ctx });
    expect(find(mk({ selected: false }), "Rename").enabled).toBe(false);
    expect(find(mk({ selected: true }), "Rename").enabled).toBeUndefined();
    expect(find(mk({ selected: false }), "Pin or unpin").enabled).toBe(false);
    expect(find(mk({ selected: false }), "Export").enabled).toBeUndefined();
  });
  test("a throwing availability check disables the item and never throws out of the build", () => {
    const boom = defineRegistry<"A", { n: number }>([{ id: "boom", group: "A", label: "Boom", key: "", icon: "x", available: (c) => c.n.toFixed() && null }]);
    const t = buildMenuTemplate({ appName: "B", registry: boom, menus: [{ label: "A", groups: ["A"] }], bindings: boom.bindingsOf(), run: () => undefined, ctx: undefined as never });
    expect(commands(t).find((i) => i.label === "Boom")!.enabled).toBe(false);
  });
  test("two menus with one label are refused", () => {
    const dup = [{ label: "Edit", groups: ["Find" as const] }, { label: "Edit", groups: ["View" as const, "Item" as const] }];
    expect(() => validateMenuCoverage(r, dup)).toThrow(/labelled "Edit"/);
    expect(() => build({}, () => undefined, dup)).toThrow(/labelled "Edit"/);
  });
  test("a function-key binding keeps its accelerator in the menu", () => {
    const t = build({ rename: "F5", pin: "⇧F6" });
    expect(commands(t).find((i) => i.label === "Rename")!.accelerator).toBe("F5");
    expect(commands(t).find((i) => i.label === "Pin or unpin")!.accelerator).toBe("Shift+F6");
  });
});


test("estate overrides reach generated menu accelerators without losing availability or coverage", () => {
  const registry = defineRegistry<"Go", { selected: boolean }>([
    { id: "palette", group: "Go", label: "Palette", key: "⌘⇧P", icon: "x", fixed: true, available: (c) => c.selected ? null : "Select an item" },
  ], { rebindableEstateDefaults: true });
  const bindings = registry.bindingsOf({ palette: "⌘⌥P", settings: "⌘⌥G", cheat: "⌘⌥/" });
  const ran: string[] = [];
  const template = buildMenuTemplate({ appName: "Demo", registry, bindings, menus: [{ label: "Go", groups: ["Go"] }], ctx: { selected: false }, run: (id) => ran.push(id) });
  const menuCommands = commands(template);
  expect(menuCommands.find((i) => i.label === "Palette")).toMatchObject({ accelerator: "Cmd+Alt+P", registerAccelerator: false, enabled: false });
  expect(menuCommands.find((i) => i.label === "Settings…")?.accelerator).toBe("Cmd+Alt+G");
  expect(menuCommands.find((i) => i.label === "Keyboard cheat sheet")?.accelerator).toBe("Cmd+Alt+/");
  menuCommands.forEach((i) => i.click!());
  expect(ran.sort()).toEqual(registry.defs.map((d) => d.id).sort());
});
