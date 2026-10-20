import { defineRegistry, type CommandDef } from "./registry.ts";

export type FixtureGroup = "Find" | "View" | "Item" | "App";
export interface FixtureCtx { selected: boolean }
type Def = CommandDef<FixtureGroup, FixtureCtx>;

const needsItem = (ctx: FixtureCtx) => (ctx.selected ? null : "select an item first");
const d = (id: string, group: FixtureGroup, label: string, key: string, icon: string, more: Partial<Def> = {}): Def => ({ id, group, label, key, icon, ...more });

export const FIXTURE_DEFS: Def[] = [
  d("palette", "Find", "Command palette", "⌘⇧P", "command", { typing: true, fixed: true }),
  d("find", "Find", "Find in this item", "⌘F", "text-search", { typing: true, fixed: true, available: needsItem }),
  d("next", "Find", "Next item", "↓", "arrow-down", { noMenu: true, noMenuReason: "bare-key navigation" }),
  d("prev", "Find", "Previous item", "↑", "arrow-up", { noMenu: true, noMenuReason: "bare-key navigation" }),
  d("open", "Find", "Open", "↵", "corner-down-right", { noMenu: true, noMenuReason: "bare-key action", available: needsItem }),
  d("filter-all", "Find", "Show all items", "⌘⌥1", "inbox"),
  d("view-list", "View", "List view", "⌘1", "list", { typing: true }),
  d("zoom-in", "View", "Zoom in", "⌘=", "zoom-in", { typing: true }),
  d("rename", "Item", "Rename", "⌘R", "pencil", { available: needsItem }),
  d("pin", "Item", "Pin or unpin", "⌘D", "pin", { available: needsItem }),
  d("export", "Item", "Export", "", "download"),
  d("undo", "App", "Undo", "⌘Z", "undo-2", { fixed: true, noMenu: true, noMenuReason: "the Edit menu has Undo" }),
  d("cheat", "App", "Cheat sheet (app wording)", "⌘/", "keyboard", { typing: true, fixed: true }),
  d("rebind", "App", "Change the shortcut", "⌘⇧,", "keyboard", { typing: true, fixed: true, hidden: true, noMenu: true, noMenuReason: "lives in the palette footer" }),
];

export const fixture = defineRegistry<FixtureGroup, FixtureCtx>(FIXTURE_DEFS);
