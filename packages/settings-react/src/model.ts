/**
 * The window's reading of the core: one place that turns the state, the schema and the registry into the things a component draws.
 * Counts, history, filters and search come from `@app-patterns/settings`'s queries; this file only shapes their results and words them.
 */
import { splitChord, toAccelerator } from "@app-patterns/commands";
import {
  changedFromDefault, INVALID_SAVED_SETTINGS, INVALID_SAVED_SHORTCUTS, actorOf, isSecretEntry, filterChanges, formatValue, historyOf, lastChange, valueOf,
  type ActorKind, type ChangeEntry, type ChangeFilter, type Schema, type SettingDef, type SettingsState, type SettingValue,
} from "@app-patterns/settings";
import { dayGroup, earlierHeading, type DayGroup } from "./format.ts";
import type { RowHint, SettingsRegistry } from "./types.ts";

export interface Ctx {
  schema: Schema;
  state: SettingsState;
  registry: SettingsRegistry;
  now: number;
  seenAt: number;
  hints: Record<string, RowHint>;
  cli: string;
  /** Effective chord of every command. */
  bindings: Record<string, string>;
  /** What differs from the default, from the core's `changedFromDefault`: setting keys and command ids. */
  changed: { settings: ReadonlySet<string>; commands: ReadonlySet<string> };
}

/** The sets the rows read, computed once per render from the core. */
export function changedSets(state: SettingsState, schema: Schema): Ctx["changed"] {
  const c = changedFromDefault(state, schema);
  return { settings: new Set(c.settings), commands: new Set(c.keys) };
}

export const SHORTCUTS = "shortcuts";
const APPLE_ORDER = ["⌃", "⌥", "⇧", "⌘"];
/** A chord as macOS writes it (⌃ ⌥ ⇧ ⌘, then the key); the registry keeps its own canonical order. "None" for no shortcut. */
export function showChord(chord: string | null | undefined): string {
  if (!chord) return "None";
  const { mods, key } = splitChord(chord);
  return APPLE_ORDER.filter((x) => mods.includes(x)).join("") + key;
}

/** A setting's value in the user's words: the core's `formatValue`, with chords written as macOS writes them. */
export function showValue(def: SettingDef | undefined, value: SettingValue | null | undefined): string {
  if (def?.type === "chord" && value !== null && value !== undefined) return showChord(String(value));
  return formatValue(def, value);
}

export const isChanged = (ctx: Ctx, key: string): boolean => ctx.changed.settings.has(key);

/** The agent who changed a setting last, when that change is newer than the last time Changes was opened. */
export function freshAgentChange(ctx: Ctx, target: string | { commandId: string }): ChangeEntry | undefined {
  const last = lastChange(ctx.state, target);
  if (!last || last.at <= ctx.seenAt) return undefined;
  return actorOf(last.who) === "agent" && last.who.kind !== "reset" ? last : undefined;
}

export type WhoKind = ActorKind;
export interface WhoView {
  kind: WhoKind | "other";
  /** "You", an agent's name, "Update 0.31.0", "Import". */
  label: string;
}

/** An actor kind this window has no wording for (a newer store's): shown neutrally, never as "You". */
export const OTHER_WHO: WhoView = { kind: "other", label: "Other" };

export function whoView(who: ChangeEntry["who"]): WhoView {
  // Narrow on the string kind so a kind a newer store adds still compiles and lands in the neutral default.
  const w = who as { kind: string; name?: unknown; version?: unknown; by?: { kind?: string; name?: unknown } };
  switch (w.kind) {
    case "you": return { kind: "you", label: "You" };
    case "agent": return typeof w.name === "string" && w.name ? { kind: "agent", label: w.name } : { kind: "agent", label: "Agent" };
    case "app-update": return { kind: "app-update", label: typeof w.version === "string" && w.version ? `Update ${w.version}` : "App update" };
    case "import": return { kind: "import", label: "Import" };
    case "reset":
      if (w.by?.kind === "agent") return typeof w.by.name === "string" && w.by.name ? { kind: "agent", label: w.by.name } : { kind: "agent", label: "Agent" };
      return w.by === undefined || w.by.kind === "you" ? { kind: "you", label: "You" } : OTHER_WHO;
    default: return OTHER_WHO;
  }
}

export interface EntryView {
  entry: ChangeEntry;
  /** The setting's label, or "Shortcut: Go to heading". */
  title: string;
  section: string;
  from: string;
  to: string;
  isReset: boolean;
  who: WhoView;
  /** The loader's note: nothing to show as old → new, nothing to put back. */
  summary?: string;
  /** The setting key, or command id, whichever it is. */
  target: string;
}

export function commandLabel(ctx: Ctx, id: string): string {
  return ctx.registry.byId(id)?.label ?? id;
}

/** How an entry is worded. */
export function entryView(ctx: Ctx, e: ChangeEntry): EntryView {
  const who = whoView(e.who);
  const isReset = e.who.kind === "reset";
  if (e.key !== undefined) {
    const def = ctx.schema.def(e.key);
    const sec = def ? ctx.schema.section(def.section)?.label ?? def.section : "";
    const base = { entry: e, who, isReset, target: e.key, section: sec };
    if (e.note === INVALID_SAVED_SETTINGS || e.note === INVALID_SAVED_SHORTCUTS) return { ...base, title: "Saved settings repaired", from: "", to: "", summary: summaryText(e) };
    // A key saved or removed: status words only, and nothing to put back (a key's value is never in the changelog).
    if (def?.type === "secret" && isSecretEntry(e)) return { ...base, title: def.label, from: "", to: "", summary: e.to === "connected" ? "Key connected" : "Key removed" };
    return { ...base, title: def?.label ?? e.key, from: showValue(def, e.from), to: showValue(def, e.to) };
  }
  const id = e.commandId ?? "";
  const base = { entry: e, who, isReset, target: id, section: ctx.schema.section(SHORTCUTS)?.label ?? "Shortcuts" };
  return { ...base, title: `Shortcut: ${commandLabel(ctx, id)}`, from: e.from === null ? "—" : showChord(String(e.from)), to: e.to === null ? "—" : showChord(String(e.to)) };
}

function summaryText(e: ChangeEntry): string {
  const n = typeof e.from === "number" ? e.from : (e.targets?.length ?? 0);
  const what = e.note === INVALID_SAVED_SHORTCUTS ? "shortcut" : "setting";
  return `${n} saved ${what}${n === 1 ? "" : "s"} could not be read and went back to the default`;
}

/** The text a Changes filter matches besides the key: the label of a shortcut. */
export const labelOf = (ctx: Ctx) => (e: ChangeEntry): string | undefined => (e.commandId !== undefined ? commandLabel(ctx, e.commandId) : undefined);

export type ChangeBlock =
  | { kind: "import"; batch: string; entries: ChangeEntry[] }
  | { kind: "day"; label: string; group: DayGroup; entries: ChangeEntry[] };

/** The Changes page's cards, newest first: each import is one card, everything else is grouped into Today, Yesterday and Earlier. */
export function changeBlocks(ctx: Ctx, who: ChangeFilter, text: string): ChangeBlock[] {
  const list = filterChanges(ctx.state, { who, text, settings: ctx.schema.settings, labelOf: labelOf(ctx) });
  const blocks: ChangeBlock[] = [];
  const importAt = new Map<string, Extract<ChangeBlock, { kind: "import" }>>();
  for (const e of list) {
    if (e.who.kind === "import" && e.batch !== undefined) {
      let b = importAt.get(e.batch);
      if (!b) {
        b = { kind: "import", batch: e.batch, entries: [] };
        importAt.set(e.batch, b);
        blocks.push(b);
      }
      b.entries.push(e);
      continue;
    }
    const g = dayGroup(e.at, ctx.now);
    const last = blocks[blocks.length - 1];
    if (last && last.kind === "day" && last.group === g) last.entries.push(e);
    else blocks.push({ kind: "day", label: g, group: g, entries: [e] });
  }
  for (const b of blocks) if (b.kind === "day" && b.group === "Earlier") b.label = earlierHeading(b.entries.map((e) => e.at), ctx.now);
  return blocks;
}

export interface CommandRow {
  id: string;
  label: string;
  chord: string;
  defaultChord: string;
  changed: boolean;
  fixed: boolean;
}
export interface CommandGroup {
  group: string;
  rows: CommandRow[];
}

/** The Shortcuts page's cards: the registry's commands by group, those matching every word typed. */
export function commandGroups(ctx: Ctx, query: string, show: (d: SettingsRegistry["defs"][number]) => boolean): CommandGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const groups = new Map<string, CommandRow[]>();
  for (const d of ctx.registry.defs) {
    if (!show(d)) continue;
    if (!words.every((w) => d.label.toLowerCase().includes(w) || d.group.toLowerCase().includes(w))) continue;
    const row: CommandRow = {
      id: d.id, label: d.label, chord: ctx.bindings[d.id] ?? "", defaultChord: d.key,
      changed: ctx.changed.commands.has(d.id), fixed: d.fixed === true,
    };
    groups.set(d.group, [...(groups.get(d.group) ?? []), row]);
  }
  return [...groups].map(([group, rows]) => ({ group, rows }));
}

/** The example value in `<app> settings set <key> <value>`, as the plain value (the caller quotes it for the shell): another choice, the opposite of a toggle, a step on a number. */
export function exampleValue(def: SettingDef, current: SettingValue | null, hint: RowHint | undefined): string {
  if (hint?.example !== undefined) return hint.example;
  switch (def.type) {
    case "toggle": return current ? "false" : "true";
    case "number": {
      const step = hint?.step ?? 1;
      const next = Number((Number(current ?? 0) + step).toFixed(6));
      return String(def.max !== undefined && next > def.max ? Number(current ?? 0) - step : next);
    }
    case "choice": {
      const opts = def.options ?? [];
      const i = opts.findIndex((o) => o.value === current);
      const next = opts[(i + 1) % Math.max(opts.length, 1)];
      return next === undefined ? "…" : String(next.value);
    }
    case "path": return "~/Documents";
    case "chord": return "Alt+Cmd+R";
    default: return "…";
  }
}

export const acceleratorOf = (chord: string): string => (chord ? toAccelerator(chord) ?? chord : "Cmd+Shift+K");

export const currentOf = (ctx: Ctx, key: string): SettingValue | null => valueOf(ctx.state, ctx.schema, key);
