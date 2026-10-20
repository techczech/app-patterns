/**
 * Shortcut overrides. The core does not depend on `@app-patterns/commands`; the host passes a `CommandsAdapter` whose `resolve` has the shape
 * of the registry's `resolveBindings`. Every keys map the core produces is judged as a whole set by `resolve`, never chord by chord
 * against partial state, so a swap survives a reload and a reset cannot leave two commands on one chord.
 */
import { chordShapeError, type Schema } from "./schema.ts";
import { LIMITS } from "./changes.ts";

export interface Rejected {
  commandId: string;
  chord: string;
  reason: string;
}

export interface Resolution {
  /** Every command's effective chord. */
  bindings: Record<string, string>;
  /** Overrides that cannot stand in this set (reserved, invalid, colliding), with why. */
  rejected: Rejected[];
}

export interface CommandsAdapter {
  isCommand(commandId: string): boolean;
  /** The command's default chord ("" = none). Only asked for ids where `isCommand` is true. */
  defaultChord(commandId: string): string;
  /** Judges a whole override set. */
  resolve(overrides: Readonly<Record<string, string>>): Resolution;
}

/** Why `commandId` cannot carry a shortcut override: not a registry command, too long, or the key of a setting (a secret above all). */
export function commandIdError(commandId: string, schema: Schema, commands: CommandsAdapter): string | null {
  if (commandId.length === 0 || commandId.length > LIMITS.id) return "That is not a command";
  if (schema.def(commandId)) return "That is a setting, not a command";
  if (!commands.isCommand(commandId)) return `There is no command "${commandId}"`;
  return null;
}

/** Why a value cannot be an override for `commandId` before the whole-set check, or null. */
export function overrideError(commandId: string, chord: unknown, schema: Schema, commands: CommandsAdapter): string | null {
  return commandIdError(commandId, schema, commands) ?? chordShapeError(chord);
}

/** Removes overrides equal to the command's default (the file keeps only what differs). */
export function normalise(keys: Record<string, string>, commands: CommandsAdapter): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, chord] of Object.entries(keys)) if (chord !== commands.defaultChord(id)) out[id] = chord;
  return out;
}

/** The first reason the whole set is refused, or null when it stands. */
export function setError(keys: Record<string, string>, commands: CommandsAdapter): string | null {
  return commands.resolve(keys).rejected[0]?.reason ?? null;
}

/** A wanted override change: a chord, or `null` to go back to the default. */
export interface Wanted {
  commandId: string;
  chord: string | null;
}

const applyWanted = (base: Record<string, string>, ws: readonly Wanted[], commands: CommandsAdapter): Record<string, string> => {
  const out = { ...base };
  for (const w of ws) {
    if (w.chord === null || w.chord === commands.defaultChord(w.commandId)) delete out[w.commandId];
    else out[w.commandId] = w.chord;
  }
  return out;
};

/**
 * A maximal subset of `wanted` (deterministic by input order; not necessarily the largest) that, applied to `base` together,
 * `resolve` accepts whole. Starts from all of them (a swap needs that). While the set is refused, removes one change: the last in
 * input order among those the resolution names (or the last left, when it names only base overrides), and judges again. Once clean,
 * tries each removed change again, one at a time in input order, and keeps it if the set stays clean. `base` is assumed to stand on
 * its own.
 */
export function settle(base: Record<string, string>, wanted: readonly Wanted[], commands: CommandsAdapter): { accepted: Wanted[]; rejected: (Wanted & { reason: string })[] } {
  const judge = (ws: readonly Wanted[]) => commands.resolve(applyWanted(base, ws, commands)).rejected;
  let kept = [...wanted];
  const removed = new Set<Wanted>();
  for (let r = judge(kept); r.length > 0 && kept.length > 0; r = judge(kept)) {
    const named = new Set(r.map((x) => x.commandId));
    const drop = kept.findLast((w) => named.has(w.commandId)) ?? kept[kept.length - 1]!;
    kept = kept.filter((w) => w !== drop);
    removed.add(drop);
  }
  for (const w of wanted) {
    if (!removed.has(w)) continue;
    const trial = wanted.filter((x) => x === w || kept.includes(x));
    if (judge(trial).length === 0) {
      kept = trial;
      removed.delete(w);
    }
  }
  const rejected = wanted
    .filter((w) => removed.has(w))
    .map((w) => {
      const r = judge([...kept, w]);
      return { ...w, reason: (r.find((x) => x.commandId === w.commandId) ?? r[0])?.reason ?? "Conflicts with another shortcut" };
    });
  return { accepted: kept, rejected };
}
