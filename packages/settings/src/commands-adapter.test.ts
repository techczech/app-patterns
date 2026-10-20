import { describe, expect, it } from "bun:test";
import { defineRegistry } from "../../commands/src/index.ts";
import { commandsAdapter } from "./commands-adapter.ts";
import { defineSchema } from "./schema.ts";
import { emptyState } from "./state.ts";
import { rebind, rebindMany } from "./operations.ts";
import { loadState } from "./load.ts";

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
