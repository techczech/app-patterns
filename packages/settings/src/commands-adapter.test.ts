import { describe, expect, it } from "bun:test";
import { defineRegistry } from "../../commands/src/index.ts";
import { commandsAdapter } from "./commands-adapter.ts";
import { defineSchema } from "./schema.ts";
import { emptyState } from "./state.ts";
import { rebind, rebindMany } from "./operations.ts";
import { loadState } from "./load.ts";
import { previewImport, applyImport } from "./transfer.ts";

const registry = defineRegistry<"Item" | "Go">([
  { id: "rename", group: "Item", label: "Rename", key: "⌘R", icon: "pencil" },
  { id: "pin", group: "Item", label: "Pin or unpin", key: "⌘D", icon: "pin" },
  { id: "palette", group: "Go", label: "Command palette", key: "⌘⇧P", icon: "command", fixed: true, typing: true },
]);
const commands = commandsAdapter(registry);
const schema = defineSchema({ app: "demo", settings: [] });
let n = 0;
const ctx = { schema, commands, who: { kind: "you" } as const, now: () => 1, newId: () => `i${++n}` };

describe("commandsAdapter", () => {
  it("answers isCommand and defaultChord from the registry, frame commands included", () => {
    expect(commands.isCommand("rename")).toBe(true);
    expect(commands.isCommand("settings")).toBe(true);
    expect(commands.isCommand("nope")).toBe(false);
    expect(commands.defaultChord("pin")).toBe("⌘D");
    expect(commands.defaultChord("nope")).toBe("");
  });

  it("resolves a whole set and words each rejection as the registry does", () => {
    const why = (o: Record<string, string>) => Object.fromEntries(commands.resolve(o).rejected.map((x) => [x.commandId, x.reason]));
    expect(why({ rename: "⌘D" })).toEqual({ rename: "⌘D is already used by “Pin or unpin”" });
    expect(why({ palette: "⌘⌥P", ghost: "⌘G" })).toEqual({ palette: "This shortcut is the same in all the apps, so it cannot be changed", ghost: 'There is no command "ghost"' });
    expect(why({ pin: "⌘⇧K" }).pin).toContain("is kept for");
    expect(why({ pin: "K" }).pin).toContain("alone is for typing");
    expect(commands.resolve({ rename: "⌘⌥R" })).toMatchObject({ rejected: [], bindings: { rename: "⌘⌥R", pin: "⌘D" } });
  });

  it("drives the core's operations: a swap stands and survives a reload, a collision is refused in words", () => {
    const swap = rebindMany(emptyState("demo"), [{ commandId: "rename", chord: "⌘D" }, { commandId: "pin", chord: "⌘R" }], ctx);
    expect(swap.ok).toBe(true);
    if (!swap.ok) return;
    const back = loadState(JSON.parse(JSON.stringify(swap.state)), { ...ctx, appVersion: "1" });
    expect(back.state.keys).toEqual({ rename: "⌘D", pin: "⌘R" });
    expect(back.entries).toEqual([]);
    expect(rebind(emptyState("demo"), "rename", "⌘D", ctx)).toMatchObject({ ok: false, code: "invalid-chord", error: "⌘D is already used by “Pin or unpin”" });
  });
});


describe("shared estate and platform contracts through Settings", () => {
  const registry = defineRegistry([{ id: "palette", group: "Go", label: "Palette", key: "⌘⇧P", icon: "x", fixed: true }], { rebindableEstateDefaults: true });
  const commands = commandsAdapter(registry);
  const context = { ...ctx, commands };
  it("keeps valid saved and migrated estate overrides through load and rebind", () => {
    const keys = { palette: "⌘⌥P", settings: "⌘⌥G", cheat: "⌘⌥/" };
    const loaded = loadState({ ...emptyState("demo"), keys }, { ...context, appVersion: "1" });
    expect(loaded.state.keys).toEqual(keys);
    expect(loaded.entries).toEqual([]);
    const migrated = loadState({ legacy: true }, { ...context, appVersion: "1", migrate: () => ({ settings: {}, keys }) });
    expect(migrated.state.keys).toEqual(keys);
    expect(rebind(emptyState("demo"), "palette", keys.palette, context)).toMatchObject({ ok: true, state: { keys: { palette: keys.palette } } });
  });
  it("imports accepted estate bindings and skips platform conflicts with specific reasons", () => {
    for (const [chord, reason] of [["⌘⌃⌥⇧R", /four modifiers|Raycast/], ["⌃→", /Spaces|Mission Control/]] as const) {
      const file = { format: "bridle-settings-export", version: 1, app: "demo", settings: {}, keys: { settings: "⌘⌥G", palette: chord } };
      const preview = previewImport(emptyState("demo"), JSON.stringify(file), { schema, commands });
      expect(preview.changes).toEqual([expect.objectContaining({ commandId: "settings", to: "⌘⌥G" })]);
      expect(preview.skipped).toHaveLength(1);
      expect(preview.skipped[0]?.reason).toMatch(reason);
      const applied = applyImport(emptyState("demo"), preview, { file: "settings.json" }, context);
      expect(applied).toMatchObject({ ok: true, state: { keys: { settings: "⌘⌥G" } } });
      expect(rebind(emptyState("demo"), "palette", chord, context)).toMatchObject({ ok: false, error: expect.stringMatching(reason) });
    }
  });
});
