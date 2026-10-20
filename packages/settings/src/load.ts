/**
 * Reading a settings file's contents (already parsed). Tolerant per field: a value that is not valid falls back to its default and an
 * `INVALID_SAVED_VALUE` entry is logged (without the bad value). A file that is not a settings file at all is reported in `problem`;
 * the node layer renames it `.damaged` (invariant 7). An app's legacy file goes through its `migrate` hook.
 *
 * Whatever an operation writes reads back unchanged: changelog entries are rebuilt from their known fields to the same limits the
 * writers keep, and the shortcut set is judged whole, as the operations judge it.
 *
 * The loader's own entries (what it repaired, a dropped batch) are never pushed out by the changelog cap: more than
 * `REPAIR_SUMMARY_LIMIT` repairs of one kind become one summary entry, and the cap drops the oldest saved history to make room.
 */
import {
  CHANGELOG_KEY, capChanges, groupsOf, sortedTargets, INVALID_SAVED_SETTINGS, INVALID_SAVED_SHORTCUTS, INVALID_SAVED_VALUE, isSecretEntry, MAX_CHANGES, readEntry,
  REPAIR_SUMMARY_LIMIT, type ChangeEntry, type Who,
} from "./changes.ts";
import { overrideError, settle, type CommandsAdapter } from "./keys.ts";
import { checkValue, type Schema, type SettingValue } from "./schema.ts";
import { emptyState, STATE_FORMAT, STATE_VERSION, type Clock, type SettingsState } from "./state.ts";

/** What an app's `migrate` hook returns from its legacy file: values by setting key and shortcut overrides by command id. */
export interface Migrated {
  settings?: Record<string, unknown>;
  keys?: Record<string, unknown>;
}

export interface LoadContext extends Clock {
  schema: Schema;
  /** The running app's version: who the loader's own entries are attributed to (`app-update`). */
  appVersion: string;
  commands: CommandsAdapter;
  /** Reads the app's file from before shared settings; null when it is not that either. */
  migrate?(old: unknown): Migrated | null;
}

export type LoadProblem =
  /** Not a settings file (and not a legacy one the hook understood): treat as damaged. */
  | "not-settings"
  /** Another app's settings file. */
  | "other-app"
  /** Written by a newer version of this package: do not overwrite it. */
  | "newer-version";

export interface LoadResult {
  state: SettingsState;
  /** Entries the loader added (invalid values, migration, a dropped oversized batch); non-empty means the file should be written back. */
  entries: ChangeEntry[];
  problem?: LoadProblem;
  migrated: boolean;
  /**
   * What was dropped without an entry of its own, for a log line: unknown setting keys, secrets found in the file, unknown commands,
   * malformed changelog entries, entries about a secret setting.
   */
  dropped: string[];
  /**
   * The file on disk is not, structurally, what writing `state` would produce: the loader dropped or altered some part of it (an entry,
   * a value, a whole field, an unknown field, an unknown property of a kept entry, a value equal to its default, history past the cap).
   * Such a file is written back at once as a pure repair, unjudged: whatever was dropped may be a secret under a name no check can
   * recognise, and the next accepted write would lose it anyway. Always true for a migrated legacy file.
   */
  lossy: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const bad = (problem: LoadProblem, app: string): LoadResult => ({ state: emptyState(app), entries: [], problem, migrated: false, dropped: [], lossy: false });

/**
 * Whether two values parsed from JSON (or built from such) are the same, property order aside. Iterative (no recursion, no argument
 * spreading): the file size cap bounds the work. A property whose value is `undefined` is not written by JSON, so it counts as absent.
 */
function sameJson(a: unknown, b: unknown): boolean {
  const pairs: [unknown, unknown][] = [[a, b]];
  while (pairs.length) {
    const [x, y] = pairs.pop()!;
    if (x === y) continue;
    if (Array.isArray(x)) {
      if (!Array.isArray(y) || x.length !== y.length) return false;
      for (let i = 0; i < x.length; i++) pairs.push([x[i], y[i]]);
      continue;
    }
    if (!isRecord(x) || !isRecord(y)) return false;
    const kx = Object.keys(x).filter((k) => x[k] !== undefined);
    const ky = Object.keys(y).filter((k) => y[k] !== undefined);
    if (kx.length !== ky.length) return false;
    for (const k of kx) {
      if (!Object.hasOwn(y, k)) return false;
      pairs.push([x[k], y[k]]);
    }
  }
  return true;
}

/** Reads `raw` (the parsed file, or undefined when there is none) into a valid state. Never throws. */
export function loadState(raw: unknown, ctx: LoadContext): LoadResult {
  const app = ctx.schema.app;
  if (raw === undefined || raw === null) return { state: emptyState(app), entries: [], migrated: false, dropped: [], lossy: false };
  const who: Who = { kind: "app-update", version: ctx.appVersion.slice(0, 200) };
  const r = isRecord(raw) ? raw : undefined;
  if (r?.format === STATE_FORMAT) {
    if (r.app !== app) return bad("other-app", app);
    if (typeof r.version === "number" && r.version > STATE_VERSION) return bad("newer-version", app);
    if (r.version !== STATE_VERSION) return bad("not-settings", app);
    const dropped: string[] = [];
    const { changes, oversized } = readChanges(r.changes, ctx.schema, ctx.commands, dropped);
    if (r.settings !== undefined && !isRecord(r.settings)) dropped.push("settings");
    if (r.keys !== undefined && !isRecord(r.keys)) dropped.push("keys");
    const read = readValues(isRecord(r.settings) ? r.settings : {}, isRecord(r.keys) ? r.keys : {}, ctx, who, false, dropped, oversized);
    const state: SettingsState = { ...emptyState(app), settings: read.settings, keys: read.keys, changes: withLoaderEntries(read.entries, changes) };
    // Compared whole, not tracked per drop site: whatever any check above left out or changed shows up here.
    return { state, entries: read.entries, migrated: false, dropped, lossy: !sameJson(raw, state) };
  }
  let old: Migrated | null = null;
  try {
    const m = ctx.migrate?.(raw);
    old = isRecord(m) ? m : null;
  } catch {
    old = null;
  }
  if (!old) return bad("not-settings", app);
  const dropped: string[] = [];
  const read = readValues(isRecord(old.settings) ? old.settings : {}, isRecord(old.keys) ? old.keys : {}, ctx, who, true, dropped, 0);
  return { state: { ...emptyState(app), settings: read.settings, keys: read.keys, changes: withLoaderEntries(read.entries, []) }, entries: read.entries, migrated: true, dropped, lossy: true };
}

/**
 * The loader's entries, then as much of the saved history as fits under the cap, oldest dropped first, never a batch split. The
 * loader's entries are a single batch of at most 1 + 2 * REPAIR_SUMMARY_LIMIT, except a migration of more than the cap, whose entries
 * are unbatched with the repairs first, so the cap keeps the repairs.
 */
function withLoaderEntries(created: readonly ChangeEntry[], saved: readonly ChangeEntry[]): ChangeEntry[] {
  const out = capChanges(created);
  for (const g of groupsOf(saved)) {
    if (out.length + g.length > MAX_CHANGES) break;
    out.push(...g);
  }
  return out;
}

/**
 * Rebuilt entries, without entries about a secret (except `recordSecret`'s status-word entries), and without any batch larger than the cap (counted in `oversized`). A batch is
 * measured on the saved entries carrying its id, before any is dropped as malformed or about a secret.
 */
function readChanges(raw: unknown, schema: Schema, commands: CommandsAdapter, dropped: string[]): { changes: ChangeEntry[]; oversized: number } {
  if (raw === undefined) return { changes: [], oversized: 0 };
  if (!Array.isArray(raw)) {
    dropped.push("changes");
    return { changes: [], oversized: 0 };
  }
  const batchOf = (c: unknown): string | undefined => (isRecord(c) && typeof c.batch === "string" ? c.batch : undefined);
  const sizes = new Map<string, number>();
  for (const c of raw) {
    const b = batchOf(c);
    if (b !== undefined) sizes.set(b, (sizes.get(b) ?? 0) + 1);
  }
  const list: ChangeEntry[] = [];
  let secret = 0;
  let oversized = 0;
  raw.forEach((c, i) => {
    const b = batchOf(c);
    if (b !== undefined && sizes.get(b)! > MAX_CHANGES) return oversized++;
    const e = readEntry(c);
    if (!e) return dropped.push(`changes[${i}]`);
    // An entry about a key is kept only as `recordSecret` writes it (status words); anything else about a key is dropped.
    if (e.commandId !== undefined && schema.def(e.commandId)?.type === "secret") return secret++;
    if (e.key !== undefined && schema.def(e.key)?.type === "secret" && !isSecretEntry(e)) return secret++;
    if (e.targets) {
      // Only what a summary of that kind can name: a non-secret setting, or a command that is not a setting's key.
      const ok = e.note === INVALID_SAVED_SETTINGS
        ? (t: string) => { const d = schema.def(t); return !!d && d.type !== "secret"; }
        : (t: string) => !schema.def(t) && commands.isCommand(t);
      e.targets = e.targets.filter(ok);
    }
    list.push(e);
  });
  if (secret) dropped.push(`changes: ${secret} about a secret`);
  return { changes: list, oversized };
}

/** A migrated value is the user's own, replacing the default. */
const LOCAL = { fromOrigin: "local", toOrigin: "local" } as const;

/**
 * Validates values field by field. `logValid` (migration) also logs each valid non-default value as a change from the default.
 * All entries from one load share a batch when there is more than one.
 */
function readValues(
  settings: Record<string, unknown>,
  keys: Record<string, unknown>,
  ctx: LoadContext,
  who: Who,
  logValid: boolean,
  dropped: string[],
  oversized: number,
): { settings: Record<string, SettingValue>; keys: Record<string, string>; entries: ChangeEntry[] } {
  type Pending = Omit<ChangeEntry, "id" | "at" | "batch">;
  /** Migration's records of valid values. */
  const records: Pending[] = [];
  const badSettings: Pending[] = [];
  const badKeys: Pending[] = [];
  const outSettings: Record<string, SettingValue> = {};
  for (const [key, value] of Object.entries(settings)) {
    const def = ctx.schema.def(key);
    if (!def) {
      dropped.push(`settings.${key.slice(0, 200)}`);
      continue;
    }
    if (def.type === "secret") {
      // Never in the file and never in the log: dropped, the value not kept anywhere.
      dropped.push(`settings.${key}`);
      continue;
    }
    if (checkValue(def, value) === null) {
      if (value === def.default) continue;
      outSettings[key] = value as SettingValue;
      if (logValid) records.push({ key, from: def.default, to: value as SettingValue, who, ...LOCAL });
      continue;
    }
    badSettings.push({ key, from: null, to: def.default, who, note: INVALID_SAVED_VALUE });
  }
  const candidate: { commandId: string; chord: string }[] = [];
  for (const [commandId, chord] of Object.entries(keys)) {
    if (!ctx.commands.isCommand(commandId) || ctx.schema.def(commandId) || commandId.length > 200) {
      dropped.push(`keys.${commandId.slice(0, 200)}`);
      continue;
    }
    if (overrideError(commandId, chord, ctx.schema, ctx.commands)) {
      badKeys.push({ commandId, from: null, to: ctx.commands.defaultChord(commandId), who, note: INVALID_SAVED_VALUE });
      continue;
    }
    if (chord === ctx.commands.defaultChord(commandId)) continue;
    candidate.push({ commandId, chord: chord as string });
  }
  const s = settle({}, candidate, ctx.commands);
  const outKeys: Record<string, string> = {};
  for (const w of s.accepted) {
    outKeys[w.commandId] = w.chord!;
    if (logValid) records.push({ commandId: w.commandId, from: ctx.commands.defaultChord(w.commandId), to: w.chord, who, ...LOCAL });
  }
  for (const w of s.rejected) badKeys.push({ commandId: w.commandId, from: null, to: ctx.commands.defaultChord(w.commandId), who, note: INVALID_SAVED_VALUE });
  const summed = (list: Pending[], note: typeof INVALID_SAVED_SETTINGS | typeof INVALID_SAVED_SHORTCUTS): Pending[] =>
    list.length > REPAIR_SUMMARY_LIMIT
      ? [{ key: CHANGELOG_KEY, from: list.length, to: null, who, note, targets: sortedTargets(list.map((e) => e.key ?? e.commandId)) }]
      : list;
  const repairs: Pending[] = [
    ...(oversized ? [{ key: CHANGELOG_KEY, from: oversized, to: null, who, note: INVALID_SAVED_VALUE } as Pending] : []),
    ...summed(badSettings, INVALID_SAVED_SETTINGS),
    ...summed(badKeys, INVALID_SAVED_SHORTCUTS),
  ];
  // Newest first after the reverse below: the repairs lead, so a cut of an unbatched migration keeps them.
  const pending = [...records, ...repairs];
  const at = ctx.now();
  const ids = pending.map(() => ctx.newId());
  const batch = pending.length > 1 ? ctx.newId() : undefined;
  // A migration of more than the cap cannot be one batch; its entries are then left unbatched (the cap keeps the newest).
  const useBatch = batch !== undefined && pending.length <= MAX_CHANGES;
  const entries = pending.map((e, i): ChangeEntry => ({ id: ids[i]!, at, ...e, ...(useBatch ? { batch } : {}) })).reverse();
  return { settings: outSettings, keys: outKeys, entries };
}
