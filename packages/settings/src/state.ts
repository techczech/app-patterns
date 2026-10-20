/**
 * The settings state, which is also the file (format v2), and the one place a change is written: `commit` applies a list of targets,
 * drops values that equal the default, and logs one entry per target that really changed.
 */
import { boundActor, capChanges, MAX_CHANGES, type Actor, type ChangeEntry, type ValueOrigin, type Who } from "./changes.ts";
import { setError, type CommandsAdapter } from "./keys.ts";
import type { Schema, SettingValue } from "./schema.ts";

export const STATE_FORMAT = "bridle-settings";
export const STATE_VERSION = 2;

export interface SettingsState {
  format: typeof STATE_FORMAT;
  version: typeof STATE_VERSION;
  app: string;
  /** Only values that differ from the default. Never a secret. */
  settings: Record<string, SettingValue>;
  /** Shortcut overrides: command id to chord ("" = no shortcut). Only chords that differ from the command's default. */
  keys: Record<string, string>;
  /** Newest first. */
  changes: ChangeEntry[];
}

export const emptyState = (app: string): SettingsState => ({ format: STATE_FORMAT, version: STATE_VERSION, app, settings: {}, keys: {}, changes: [] });

export type { CommandsAdapter } from "./keys.ts";

/** Injected by the caller so every operation is deterministic. */
export interface Clock {
  now(): number;
  newId(): string;
}

export interface OpContext extends Clock {
  schema: Schema;
  /** Who is making the change (you in the window, an agent through the CLI). */
  who: Actor;
  commands: CommandsAdapter;
}

/** A setting or a shortcut. */
export type Target = { key: string } | { commandId: string };
export const targetOf = (e: { key?: string; commandId?: string }): Target => (e.key !== undefined ? { key: e.key } : { commandId: e.commandId! });
export const targetId = (t: Target): string => ("key" in t ? `setting:${t.key}` : `key:${t.commandId}`);

/** A setting's value now: the stored one, or its default. */
export function valueOf(state: SettingsState, schema: Schema, key: string): SettingValue | null {
  const def = schema.def(key);
  if (!def || def.type === "secret") return null;
  return Object.hasOwn(state.settings, key) ? state.settings[key]! : def.default;
}

/** A command's effective chord: its override, or its default. */
export function chordOf(state: SettingsState, commandId: string, commands: CommandsAdapter): string {
  return Object.hasOwn(state.keys, commandId) ? state.keys[commandId]! : commands.defaultChord(commandId);
}

export function currentOf(state: SettingsState, schema: Schema, t: Target, commands: CommandsAdapter): SettingValue | null {
  return "key" in t ? valueOf(state, schema, t.key) : chordOf(state, t.commandId, commands);
}

/**
 * Where the value a target holds now came from, or undefined when that is not known. The default is always `local`. Otherwise the newest
 * entry about the target says, when its `to` is the value held now (a value changed outside the log, or an entry cut by the cap, or one
 * written before origins were recorded, leaves it unknown).
 */
export function originOf(state: SettingsState, schema: Schema, t: Target, commands: CommandsAdapter): ValueOrigin | undefined {
  const now = currentOf(state, schema, t, commands);
  const dflt = "key" in t ? schema.def(t.key)?.default : commands.defaultChord(t.commandId);
  if (now === dflt) return "local";
  const id = targetId(t);
  const last = state.changes.find((e) => (e.key !== undefined || e.commandId !== undefined) && targetId(targetOf(e)) === id);
  return last && last.to === now ? last.toOrigin : undefined;
}

/** One wanted change. `toDefault` removes the stored value or override whatever the default is. */
export interface Write {
  target: Target;
  to: SettingValue | null;
  toDefault?: boolean;
  /** Overrides the operation's who for this entry (Reset of one entry names that entry). */
  who?: Who;
  /**
   * Origin of `to` (a restore passes the origin recorded for the value it puts back; null: unknown). Default: `import` when the write's
   * who is an import, else `local`; a write to the default is always `local`.
   */
  origin?: ValueOrigin | null;
}

export type OpResult = { ok: true; state: SettingsState; entries: ChangeEntry[]; batch?: string } | { ok: false; code: OpErrorCode; error: string };
export type OpErrorCode = "unknown-key" | "unknown-command" | "secret" | "invalid-value" | "invalid-chord" | "not-found" | "already" | "not-possible" | "too-many";
export const fail = (code: OpErrorCode, error: string): { ok: false; code: OpErrorCode; error: string } => ({ ok: false, code, error });

export type Committed = { state: SettingsState; entries: ChangeEntry[]; batch?: string };

/**
 * Applies writes in order and logs one entry for each target whose value really changed. More than one entry (or `forceBatch`) gets a
 * shared batch id. The caller has validated each value; this refuses, changing nothing, when the resulting shortcut set does not stand
 * whole, or when the batch would be larger than the changelog cap.
 */
export function commit(
  state: SettingsState,
  writes: readonly Write[],
  ctx: Clock & { schema: Schema; commands: CommandsAdapter },
  who: Who,
  forceBatch = false,
): Committed | { ok: false; code: OpErrorCode; error: string } {
  const settings = { ...state.settings };
  const keys = { ...state.keys };
  const next = { ...state, settings, keys };
  const pending: Omit<ChangeEntry, "id" | "at" | "batch">[] = [];
  const pendingAsEntries = (): ChangeEntry[] => pending.map((e) => ({ id: "", at: 0, ...e })).reverse();
  const by = (w: Write): Who => {
    const x = w.who ?? who;
    if (x.kind === "you" || x.kind === "agent" || x.kind === "app-update") return boundActor(x);
    if (x.kind === "reset" && x.by) return { ...x, by: boundActor(x.by) };
    if (x.kind === "import" && x.by) return { ...x, by: boundActor(x.by) };
    return x;
  };
  let keysChanged = false;
  /** Origins of `to` and of the value replaced, for an entry. */
  const origins = (w: Write, x: Who, fromOrigin: ValueOrigin | undefined, toDefault: boolean) => {
    const to = toDefault ? "local" : w.origin === undefined ? (x.kind === "import" ? "import" : "local") : (w.origin ?? undefined);
    return { ...(fromOrigin ? { fromOrigin } : {}), ...(to ? { toOrigin: to } : {}) };
  };
  for (const w of writes) {
    const from = currentOf(next, ctx.schema, w.target, ctx.commands);
    // The log as it will be once the entries before this one are in (a target written twice in one commit).
    const fromOrigin = originOf({ ...next, changes: [...pendingAsEntries(), ...state.changes] }, ctx.schema, w.target, ctx.commands);
    if ("key" in w.target) {
      const def = ctx.schema.def(w.target.key);
      if (!def || def.type === "secret") continue;
      const to = w.toDefault ? def.default : w.to;
      if (to === null) continue;
      if (to === def.default) delete settings[w.target.key];
      else settings[w.target.key] = to;
      if (from === to) continue;
      pending.push({ key: w.target.key, from, to, who: by(w), ...origins(w, w.who ?? who, fromOrigin, to === def.default) });
    } else {
      const id = w.target.commandId;
      if (ctx.schema.def(id)) continue; // never a setting's key (a secret above all) in the shortcut map
      const def = ctx.commands.defaultChord(id);
      const to = w.toDefault ? def : (w.to as string);
      if (to === def) delete keys[id];
      else keys[id] = to;
      if (from === to) continue;
      keysChanged = true;
      pending.push({ commandId: id, from, to, who: by(w), ...origins(w, w.who ?? who, fromOrigin, to === def) });
    }
  }
  if (keysChanged) {
    const err = setError(keys, ctx.commands);
    if (err) return fail("invalid-chord", err);
  }
  if (pending.length > MAX_CHANGES) return fail("too-many", `That would change ${pending.length} settings at once; at most ${MAX_CHANGES} can be changed together`);
  const at = ctx.now();
  const ids = pending.map(() => ctx.newId());
  const batch = pending.length > 1 || (forceBatch && pending.length > 0) ? ctx.newId() : undefined;
  const entries = pending.map((e, i): ChangeEntry => ({ id: ids[i]!, at, ...e, ...(batch === undefined ? {} : { batch }) })).reverse();
  next.changes = capChanges([...entries, ...state.changes]);
  return { state: next, entries, ...(batch !== undefined ? { batch } : {}) };
}
