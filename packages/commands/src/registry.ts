/**
 * The command registry: the one list the palette, the cheat sheet, the shortcuts page, the app menu and the key handler read.
 * A command is added here and nowhere else; a binding is what the registry says unless the user's saved overrides change it. Pure.
 */
import { canonChord, chordRestriction, isTypingSafe, isValidChord, type Chord } from "./chords.ts";
import { RESERVED_ESTATE, RESERVED_SYSTEM } from "./reserved.ts";

export interface CommandDef<G extends string = string, Ctx = unknown> {
  id: string;
  group: G;
  /** Palette, cheat sheet and Settings wording. */
  label: string;
  /** The default chord; "" is none. */
  key: Chord;
  /** A lucide icon name (the renderer maps it). */
  icon: string;
  /** Keeps this binding fixed. With `rebindableEstateDefaults`, estate default holders may move; their default meanings stay reserved. */
  fixed?: true;
  /** May fire while a text field has focus. Every other command returns early there, so typing keeps its own meaning. */
  typing?: true;
  /** Left out of the palette's rows. */
  hidden?: true;
  /** Left out of the generated menu; `noMenuReason` says why. */
  noMenu?: true;
  noMenuReason?: string;
  /**
   * The context this command's chord belongs to; absent is "global". A chord in a named scope shadows the same global chord while that
   * scope is active (the key handler passes the active scope). Only a named scope may use a bare (unmodified) key as a default or override.
   * Duplicate default chords are an error only within one scope. Reserved chords stay reserved in every scope.
   */
  scope?: string;
  /** Why the command cannot run now, in words; null when it can. */
  available?(ctx: Ctx): string | null;
}

/** What the user has changed: command id to chord, "" meaning the shortcut was removed. */
export type Overrides = Record<string, string>;
/** The chord each command answers to now. */
export type Bindings = Record<string, Chord>;

export type RebindCheck =
  | { kind: "ok" }
  | { kind: "same" }
  /** The command has a fixed binding (or is unknown). */
  | { kind: "fixed" }
  /** The chord belongs to the estate or the system, named in `by`. */
  | { kind: "reserved"; by: string }
  /** A key with no ⌘, ⌥ or ⌃ is for typing. */
  | { kind: "bare" }
  /** A command that runs while typing cannot take a bare key: the key would fire from inside a text field. */
  | { kind: "typing" }
  /** Another command has it. */
  | { kind: "taken"; by: string }
  /** A syntactically valid chord the platform keeps for another purpose. */
  | { kind: "platform"; reason: string }
  /** Not modifiers plus one supported key. */
  | { kind: "invalid" };

/** Why an override of the saved bindings was not applied. */
export interface RejectedOverride {
  commandId: string;
  chord: Chord;
  reason: "fixed" | "reserved" | "bare" | "typing" | "taken" | "platform" | "invalid" | "unknown";
}

/** The group the package's own frame commands (Settings, cheat sheet, Export and Import Settings) sit in. */
export type FrameGroup = "App";
export const FRAME_GROUP: FrameGroup = "App";
export const FRAME_SETTINGS_ID = "settings";
export const FRAME_CHEAT_ID = "cheat";
export const FRAME_EXPORT_SETTINGS = "export-settings";
export const FRAME_IMPORT_SETTINGS = "import-settings";
/** Ids of the commands the package supplies to every registry. An app may relabel them; overrides may rekey them with `rebindableEstateDefaults`. */
export const FRAME_COMMAND_IDS: readonly string[] = [FRAME_SETTINGS_ID, FRAME_CHEAT_ID, FRAME_EXPORT_SETTINGS, FRAME_IMPORT_SETTINGS];

const frameCommands = (): CommandDef<FrameGroup, never>[] => [
  { id: FRAME_SETTINGS_ID, group: FRAME_GROUP, label: "Settings…", key: "⌘,", icon: "settings", fixed: true, typing: true },
  { id: FRAME_CHEAT_ID, group: FRAME_GROUP, label: "Keyboard cheat sheet", key: "⌘/", icon: "keyboard", fixed: true, typing: true },
  { id: FRAME_EXPORT_SETTINGS, group: FRAME_GROUP, label: "Export Settings…", key: "", icon: "download" },
  { id: FRAME_IMPORT_SETTINGS, group: FRAME_GROUP, label: "Import Settings…", key: "", icon: "upload" },
];

/** A raw saved value as short, safe text for a report; never throws. */
function describeRaw(v: unknown): string {
  if (typeof v === "string") return v.slice(0, 80);
  let text: string | undefined;
  try { text = JSON.stringify(v); } catch { text = undefined; }
  return (text ?? typeof v).slice(0, 80);
}

const ID_PATTERN = /^[a-z][a-z0-9.-]*$/;

export interface PaletteRow<G extends string, Ctx> {
  def: CommandDef<G, Ctx>;
  /** Why it cannot run now; null when it can. */
  reason: string | null;
}

export interface CheatSheetGroup<G extends string> {
  group: G;
  entries: { id: string; label: string; chord: Chord }[];
}

export interface Registry<G extends string, Ctx> {
  /** A frozen copy of the definitions, with the package's frame commands merged in. */
  readonly defs: readonly CommandDef<G | FrameGroup, Ctx>[];
  /** Groups in order of first appearance. */
  readonly groups: readonly (G | FrameGroup)[];
  /** Every chord nothing else may take, to what holds it: system, estate, then this registry's fixed commands. */
  readonly reserved: Readonly<Record<Chord, string>>;
  /** Command ids that may run while an overlay (palette, cheat sheet ...) is open. */
  readonly overlayIds: ReadonlySet<string>;
  byId(id: string): CommandDef<G | FrameGroup, Ctx> | undefined;
  isCommandId(value: unknown): boolean;
  /** The effective bindings; an override that is invalid, reserved, bare or collides is dropped (see `resolveBindings`). Never throws. */
  bindingsOf(overrides?: Overrides): Bindings;
  /** As `bindingsOf`, with the overrides that were not applied and why. */
  resolveBindings(overrides?: Overrides): { bindings: Bindings; rejected: RejectedOverride[] };
  /** The command a chord runs. With `scope`, that scope's command wins, else the global one; without, only global commands match. */
  commandForChord(bindings: Bindings, chord: Chord, scope?: string): string | null;
  checkRebind(bindings: Bindings, id: string, chord: Chord): RebindCheck;
  rebindMessage(r: RebindCheck, chord: Chord): string;
  runsWhileTyping(id: string): boolean;
  /** Commands for what is typed (every word in the label or group), hidden ones left out, each with why it is unavailable. */
  paletteList(ctx: Ctx, query?: string): PaletteRow<G | FrameGroup, Ctx>[];
  /** Commands that have a chord now, by group. */
  cheatSheet(bindings: Bindings): CheatSheetGroup<G | FrameGroup>[];
}

export interface RegistryOptions {
  /**
   * Let holders of RESERVED_ESTATE default chords (including Settings and cheat sheet) move or remove their binding, even if marked
   * `fixed`. The original default chord remains reserved for that holder in every scope. Other fixed commands keep their semantics.
   * Default false preserves older callers' fixed bindings. Declare the estate default in `key`; supply saved choices as overrides.
   */
  rebindableEstateDefaults?: boolean;
  /** Command ids that still run while an overlay is open. Default: every `fixed` command and rebindable estate default holder. */
  overlayIds?: string[];
}

/**
 * Builds the registry; throws on a defect in the definitions (duplicate or malformed id, bad or colliding default chord, reserved default,
 * `noMenu` without a reason). The package's frame commands are merged in; a definition with a frame id may only change label and icon.
 * The definitions are copied and frozen, so later changes to the caller's array cannot make the registry inconsistent.
 */
export function defineRegistry<G extends string, Ctx = void>(input: readonly CommandDef<G, Ctx>[], options: RegistryOptions = {}): Registry<G, Ctx> {
  type Def = CommandDef<G | FrameGroup, Ctx>;
  const frame = new Map<string, Def>(frameCommands().map((f) => [f.id, f as Def]));
  const merged: Def[] = input.map((d) => {
    const f = frame.get(d.id);
    if (!f) return d;
    frame.delete(d.id);
    return { ...f, label: d.label || f.label, icon: d.icon || f.icon };
  });
  merged.push(...frame.values());
  // Ownership comes from declared defaults, never from labels, current bindings or saved overrides.
  const estateOwners = new Map<Chord, string>();
  if (options.rebindableEstateDefaults) for (const d of merged) {
    if (!Object.hasOwn(RESERVED_ESTATE, d.key)) continue;
    if (estateOwners.has(d.key)) throw new Error(`Command "${d.id}" defaults to ${d.key}, which is reserved for "${estateOwners.get(d.key)}"`);
    estateOwners.set(d.key, d.id);
  }
  const defs: readonly Def[] = Object.freeze(merged.map((d) => {
    const copy = { ...d };
    if (estateOwners.get(d.key) === d.id) delete copy.fixed;
    return Object.freeze(copy);
  }));

  const reserved: Record<Chord, string> = Object.assign(Object.create(null), RESERVED_SYSTEM, RESERVED_ESTATE);
  for (const d of defs) if ((d.fixed || estateOwners.get(d.key) === d.id) && d.key) reserved[canonChord(d.key)] = d.label;

  const seenIds = new Set<string>();
  const seenKeys = new Map<string, string>();
  /** The one place a scope is read: absent is "global". `validScope` is checked for every definition, bound or not. */
  const scopeOf = (d: { scope?: string }): string => d.scope ?? "global";
  const validScope = (d: Def): boolean => d.scope === undefined || (typeof d.scope === "string" && d.scope !== "" && d.scope !== "global" && d.scope === d.scope.trim());
  for (const d of defs) {
    if (typeof d.id !== "string" || !ID_PATTERN.test(d.id)) throw new Error(`Command id "${describeRaw(d.id)}" must match ${ID_PATTERN}`);
    if (seenIds.has(d.id)) throw new Error(`Duplicate command id "${d.id}"`);
    seenIds.add(d.id);
    if (d.noMenu && !d.noMenuReason) throw new Error(`Command "${d.id}" is noMenu without a noMenuReason`);
    if (!validScope(d)) throw new Error(`Command "${d.id}" has an invalid scope "${describeRaw(d.scope)}"`);
    if (!d.key) continue;
    if (!isValidChord(d.key) || canonChord(d.key) !== d.key) throw new Error(`Command "${d.id}" has an invalid default chord "${d.key}"`);
    const restriction = chordRestriction(d.key);
    if (restriction) throw new Error(`Command "${d.id}": ${restriction}`);
    const slot = `${scopeOf(d)}\u0000${d.key}`;
    const other = seenKeys.get(slot);
    if (other) throw new Error(`Commands "${other}" and "${d.id}" share the default chord ${d.key}${d.scope ? ` in scope "${d.scope}"` : ""}`);
    seenKeys.set(slot, d.id);
    if (!d.fixed && reserved[d.key] && estateOwners.get(d.key) !== d.id) throw new Error(`Command "${d.id}" defaults to ${d.key}, which is reserved for "${reserved[d.key]}"`);
  }

  const byId = (id: string): Def | undefined => defs.find((d) => d.id === id);
  const groups = [...new Set(defs.map((d) => d.group))];
  const overlayIds = new Set(options.overlayIds ?? merged.filter((d) => d.fixed || estateOwners.get(d.key) === d.id).map((d) => d.id));

  const emptyBindings = (): Bindings => Object.create(null) as Bindings;
  const resolveBindings = (overrides: Overrides = {}): { bindings: Bindings; rejected: RejectedOverride[] } => {
    const rejected: RejectedOverride[] = [];
    const has = (id: string) => Object.hasOwn(overrides, id);
    for (const id of Object.keys(overrides)) {
      const def = byId(id);
      if (!def) rejected.push({ commandId: id, chord: describeRaw(overrides[id]), reason: "unknown" });
      else if (def.fixed) rejected.push({ commandId: id, chord: describeRaw(overrides[id]), reason: "fixed" });
    }
    const out = emptyBindings();
    // Commands without an override keep their default; overridden commands start empty so chords can be swapped.
    for (const d of defs) out[d.id] = !d.fixed && has(d.id) ? "" : d.key;
    const refused: Def[] = [];
    for (const d of defs) {
      if (d.fixed || !has(d.id)) continue;
      const raw = overrides[d.id];
      if (raw === "") continue; // shortcut removed on purpose
      const chord = typeof raw === "string" ? canonChord(raw) : "";
      if (typeof raw !== "string" || !chord) { rejected.push({ commandId: d.id, chord: describeRaw(raw), reason: "invalid" }); refused.push(d); continue; }
      const check = checkRebind(out, d.id, chord);
      if (check.kind === "ok" || check.kind === "same") out[d.id] = chord;
      else { rejected.push({ commandId: d.id, chord: raw, reason: check.kind as RejectedOverride["reason"] }); refused.push(d); }
    }
    // A refused override falls back to the default, if no accepted override took it meanwhile.
    for (const d of refused) if (d.key && !heldInScope(out, d.key, scopeOf(d))) out[d.id] = d.key;
    return { bindings: out, rejected };
  };
  const bindingsOf = (overrides: Overrides = {}): Bindings => resolveBindings(overrides).bindings;
  /** The command in exactly this scope that holds the chord. */
  function heldInScope(bindings: Bindings, chord: Chord, scope: string): string | null {
    const want = canonChord(chord);
    if (!want) return null;
    for (const d of defs) {
      if (scopeOf(d) !== scope) continue;
      const held = Object.hasOwn(bindings, d.id) ? bindings[d.id] : undefined;
      if (held && canonChord(held) === want) return d.id;
    }
    return null;
  }
  function commandForChord(bindings: Bindings, chord: Chord, scope?: string): string | null {
    if (scope && scope !== "global" && scope === scope.trim()) { const hit = heldInScope(bindings, chord, scope); if (hit) return hit; }
    return heldInScope(bindings, chord, "global");
  }
  const checkRebind = (bindings: Bindings, id: string, chord: Chord): RebindCheck => {
    const def = byId(id);
    if (!def || def.fixed) return { kind: "fixed" };
    const want = canonChord(chord);
    const current = Object.hasOwn(bindings, id) ? bindings[id] ?? "" : "";
    if (!want) return current ? { kind: "ok" } : { kind: "same" };
    if (!isValidChord(want)) return { kind: "invalid" };
    const restriction = chordRestriction(want);
    if (restriction) return { kind: "platform", reason: restriction };
    if (canonChord(current) === want) return { kind: "same" };
    if (!isTypingSafe(want)) {
      if (scopeOf(def) === "global") return { kind: "bare" };
      if (def.typing) return { kind: "typing" };
    }
    const by = reserved[want];
    if (by && estateOwners.get(want) !== id) return { kind: "reserved", by };
    const other = heldInScope(bindings, want, scopeOf(def));
    if (other && other !== id) return { kind: "taken", by: other };
    return { kind: "ok" };
  };
  const rebindMessage = (r: RebindCheck, chord: Chord): string => {
    switch (r.kind) {
      case "fixed": return "This shortcut is the same in all the apps, so it cannot be changed";
      case "invalid": return "That is not a key combination this app can use";
      case "platform": return r.reason;
      case "reserved": return `${chord} is kept for “${r.by}”, so it cannot be used here`;
      case "bare": return `${chord} alone is for typing; add ⌘, ⌥ or ⌃`;
      case "typing": return `${chord} alone is for typing, and this command also runs while typing; add ⌘, ⌥ or ⌃`;
      case "taken": return `${chord} is already used by “${byId(r.by)?.label ?? r.by}”`;
      default: return "";
    }
  };
  const paletteList = (ctx: Ctx, query = ""): PaletteRow<G | FrameGroup, Ctx>[] => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return defs
      .filter((d) => !d.hidden && words.every((w) => d.label.toLowerCase().includes(w) || d.group.toLowerCase().includes(w)))
      .map((def) => ({ def, reason: def.available ? def.available(ctx) : null }));
  };
  const cheatSheet = (bindings: Bindings): CheatSheetGroup<G | FrameGroup>[] =>
    groups
      .map((group) => ({
        group,
        entries: defs.filter((d) => d.group === group && !d.hidden && Object.hasOwn(bindings, d.id) && bindings[d.id])
          .map((d) => ({ id: d.id, label: d.label, chord: bindings[d.id]! })),
      }))
      .filter((g) => g.entries.length > 0);

  return {
    defs, groups, reserved, overlayIds, byId,
    isCommandId: (value) => typeof value === "string" && seenIds.has(value),
    bindingsOf, resolveBindings, commandForChord, checkRebind, rebindMessage,
    runsWhileTyping: (id) => byId(id)?.typing === true,
    paletteList, cheatSheet,
  };
}
