/**
 * The operations: each takes the state and returns the new state plus the entries it logged (never mutates). A value already in place is
 * a success with no entries, so a repeated CLI call logs nothing. Every resulting shortcut set is judged whole (in `commit`).
 */
import { checkValue, NOT_IMPORTABLE, type Schema, type SettingValue } from "./schema.ts";
import { bound, boundActor, capChanges, INVALID_SAVED_SETTINGS, isSecretStatus, LIMITS, type ChangeEntry, type SecretStatus, type SkippedItem, type ValueOrigin } from "./changes.ts";
import { commandIdError, overrideError, settle, type Wanted } from "./keys.ts";
import {
  commit, currentOf, fail, targetId, targetOf,
  type OpContext, type OpResult, type SettingsState, type Target, type Write,
} from "./state.ts";

const ok = (r: ReturnType<typeof commit>): OpResult => ("ok" in r ? r : { ok: true, ...r });

/** Changes one setting. */
export function set(state: SettingsState, key: string, value: unknown, ctx: OpContext): OpResult {
  const def = ctx.schema.def(key);
  if (!def) return fail("unknown-key", `There is no setting "${key}"`);
  if (def.type === "secret") return fail("secret", "Keys are set in Accounts and keys and kept in Keychain, never in the settings file");
  const err = checkValue(def, value);
  if (err) return fail("invalid-value", err);
  return ok(commit(state, [{ target: { key }, to: value as SettingValue }], ctx, ctx.who));
}

/** Binds a chord to a command ("" = no shortcut). */
export function rebind(state: SettingsState, commandId: string, chord: string, ctx: OpContext): OpResult {
  return rebindMany(state, [{ commandId, chord }], ctx);
}

/** Several shortcuts in one batch (Swap and Replace on a conflict). The resulting set is judged whole; all or none. */
export function rebindMany(state: SettingsState, pairs: readonly { commandId: string; chord: string }[], ctx: OpContext): OpResult {
  if (new Set(pairs.map((p) => p.commandId)).size !== pairs.length) return fail("invalid-chord", "A command can take only one shortcut at a time");
  for (const p of pairs) {
    const idErr = commandIdError(p.commandId, ctx.schema, ctx.commands);
    if (idErr) return fail("unknown-command", idErr);
    const err = overrideError(p.commandId, p.chord, ctx.schema, ctx.commands);
    if (err) return fail("invalid-chord", err);
  }
  return ok(commit(state, pairs.map((p) => ({ target: { commandId: p.commandId }, to: p.chord })), ctx, ctx.who));
}

/**
 * Logs a key saved, replaced or removed in Accounts and keys: exactly one entry, with who, whose `from` and `to` say whether a key was
 * saved ("connected" / "missing"), never the value or any part of it. Changes no setting (keys are never in the settings file).
 */
export function recordSecret(state: SettingsState, key: string, from: SecretStatus, to: SecretStatus, ctx: OpContext): OpResult {
  const def = ctx.schema.def(key);
  if (!def) return fail("unknown-key", `There is no setting "${bound(key, LIMITS.id)}"`);
  if (def.type !== "secret") return fail("invalid-value", `"${key}" is not a key`);
  if (!isSecretStatus(from) || !isSecretStatus(to)) return fail("invalid-value", "A key's change is logged as connected or missing");
  const entry: ChangeEntry = { id: ctx.newId(), at: ctx.now(), key, from, to, who: boundActor(ctx.who) };
  return { ok: true, state: { ...state, changes: capChanges([entry, ...state.changes]) }, entries: [entry] };
}

/** Puts one setting (a key) or one shortcut (`{ commandId }`) back to its default. Refused when the default chord would collide. */
export function reset(state: SettingsState, target: string | { commandId: string }, ctx: OpContext): OpResult {
  if (typeof target === "string") {
    const def = ctx.schema.def(target);
    if (!def) return fail("unknown-key", `There is no setting "${target}"`);
    if (def.type === "secret") return fail("secret", "Keys are removed in Accounts and keys");
    return ok(commit(state, [{ target: { key: target }, to: null, toDefault: true }], ctx, ctx.who));
  }
  const idErr = commandIdError(target.commandId, ctx.schema, ctx.commands);
  if (idErr) return fail("unknown-command", idErr);
  return ok(commit(state, [{ target: { commandId: target.commandId }, to: null, toDefault: true }], ctx, ctx.who));
}

export interface ChangedFromDefault {
  /** Setting keys with a stored value, in schema order. */
  settings: string[];
  /** Commands with a shortcut override (counted in the `shortcuts` section). */
  keys: string[];
  count: number;
}

/** What differs from the default in one section, or everywhere: the "N changed from default" line and the count Reset section / Reset all confirm. */
export function changedFromDefault(state: SettingsState, schema: Schema, section?: string): ChangedFromDefault {
  const settings = schema.settings.filter((d) => d.type !== "secret" && (section === undefined || d.section === section) && Object.hasOwn(state.settings, d.key)).map((d) => d.key);
  const keys = section === undefined || section === "shortcuts" ? Object.keys(state.keys) : [];
  return { settings, keys, count: settings.length + keys.length };
}

function resetTargets(state: SettingsState, ctx: OpContext, section?: string): OpResult {
  const c = changedFromDefault(state, ctx.schema, section);
  const writes: Write[] = [
    ...c.settings.map((key): Write => ({ target: { key }, to: null, toDefault: true })),
    ...c.keys.map((commandId): Write => ({ target: { commandId }, to: null, toDefault: true })),
  ];
  return ok(commit(state, writes, ctx, ctx.who));
}

/** Every setting in a section back to its default, in one batch. `shortcuts` also resets every shortcut override. */
export function resetSection(state: SettingsState, section: string, ctx: OpContext): OpResult {
  if (!ctx.schema.section(section)) return fail("not-found", `There is no section "${section}"`);
  return resetTargets(state, ctx, section);
}

/** Every shortcut override removed (each command back to its default chord), in one batch; settings, the chord-typed ones included, are untouched. */
export function resetShortcuts(state: SettingsState, ctx: OpContext): OpResult {
  const writes = Object.keys(state.keys).map((commandId): Write => ({ target: { commandId }, to: null, toDefault: true }));
  return ok(commit(state, writes, ctx, ctx.who));
}

/** Every setting and shortcut back to its default, in one batch (take the count for the confirm from `changedFromDefault`). Keys in Keychain are untouched. */
export function resetAll(state: SettingsState, ctx: OpContext): OpResult {
  return resetTargets(state, ctx);
}

/** Why a value from the log can no longer be put back before the whole-set check, or null. */
function restoreError(ctx: OpContext, t: Target, value: SettingValue | null): string | null {
  if ("key" in t) {
    if (value === null) return "There is no earlier value to put back";
    const def = ctx.schema.def(t.key);
    if (!def) return "That setting no longer exists";
    return checkValue(def, value);
  }
  return overrideError(t.commandId, value, ctx.schema, ctx.commands);
}

/**
 * Whether putting `value` back on `t` could write a value from an import file to a setting declared `importable: false` (import history
 * from before the app marked it so). `origin` is the one the log recorded for that value: only `local` may go back; `import`, or no
 * origin (an entry from before origins were recorded), may not. The setting's default always may.
 */
function importedIntoProtected(ctx: OpContext, t: Target, value: SettingValue | null, origin: ValueOrigin | undefined): boolean {
  if (!("key" in t) || value === null) return false;
  const def = ctx.schema.def(t.key);
  if (!def || def.importable !== false || value === def.default) return false;
  return origin !== "local";
}

const restoreWrite = (t: Target, value: SettingValue | null, of: string, ctx: OpContext, origin: ValueOrigin | undefined): Write => ({
  target: t, to: value, toDefault: value === null, who: { kind: "reset", of, by: ctx.who }, origin: origin ?? null,
});

/** Puts an entry's earlier value back. The reset is a new entry (`who: reset`); the old one stays as history. */
export function resetEntry(state: SettingsState, entryId: string, ctx: OpContext): OpResult {
  const e = state.changes.find((x) => x.id === entryId);
  if (!e) return fail("not-found", "That change is no longer in the list");
  if (e.note !== undefined) return fail("not-possible", "There is no earlier value to put back");
  if (e.key !== undefined && ctx.schema.def(e.key)?.type === "secret") return fail("not-possible", "A key cannot be put back from here; enter it again in Accounts and keys");
  const t = targetOf(e);
  if (currentOf(state, ctx.schema, t, ctx.commands) === e.from) return fail("already", "It already has its earlier value");
  const err = restoreError(ctx, t, e.from);
  if (err) return fail("not-possible", err);
  if (importedIntoProtected(ctx, t, e.from, e.fromOrigin)) return fail("not-possible", `${ctx.schema.def(e.key!)?.label ?? e.key}: ${NOT_IMPORTABLE}; its earlier value came from an import file, or its origin is not known`);
  const r = commit(state, [restoreWrite(t, e.from, e.id, ctx, e.fromOrigin)], ctx, ctx.who);
  if ("ok" in r) return fail("not-possible", r.error);
  if (r.entries.length === 0) return fail("already", "It already has its earlier value");
  return { ok: true, ...r };
}

export type UndoResult = (OpResult & { ok: true; skipped: SkippedItem[] }) | (OpResult & { ok: false; skipped?: SkippedItem[] });

const CHANGED_SINCE = "Changed again since; its later value is kept";

/**
 * Undo import (or any batch): every setting the batch changed goes back to the value it had before the batch, in one new batch.
 * A target touched by any later entry keeps its later value; a shortcut whose earlier chord no longer fits the set is kept too; both are
 * listed in `skipped`.
 */
export function undoBatch(state: SettingsState, batchId: string, ctx: OpContext): UndoResult {
  const firstIdx = state.changes.findIndex((e) => e.batch === batchId);
  if (firstIdx < 0) return fail("not-found", "That batch is no longer in the list");
  // A later loader summary touched every target it names.
  const later = new Set(state.changes.slice(0, firstIdx).flatMap((e) => [
    targetId(targetOf(e)),
    ...(e.targets ?? []).map((t) => targetId(e.note === INVALID_SAVED_SETTINGS ? { key: t } : { commandId: t })),
  ]));
  const inBatch = state.changes.filter((e) => e.batch === batchId);
  // Newest first: the first entry per target names the batch's change, the last one holds the value before the batch.
  const byTarget = new Map<string, { t: Target; prior: SettingValue | null; priorOrigin: ValueOrigin | undefined; of: string; noted: boolean }>();
  for (const e of inBatch) {
    const id = targetId(targetOf(e));
    const seen = byTarget.get(id);
    if (seen) {
      seen.prior = e.from;
      seen.priorOrigin = e.fromOrigin;
    } else byTarget.set(id, { t: targetOf(e), prior: e.from, priorOrigin: e.fromOrigin, of: e.id, noted: e.note !== undefined });
  }
  const skipped: SkippedItem[] = [];
  const label = (t: Target): Pick<SkippedItem, "key" | "commandId"> => ("key" in t ? { key: bound(t.key, LIMITS.id) } : { commandId: bound(t.commandId, LIMITS.id) });
  const writes: Write[] = [];
  const wanted: (Wanted & { of: string; origin: ValueOrigin | undefined })[] = [];
  for (const [id, x] of byTarget) {
    if (x.noted) continue; // the loader's repair: nothing valid to put back
    if (currentOf(state, ctx.schema, x.t, ctx.commands) === x.prior) continue;
    if (later.has(id)) {
      skipped.push({ ...label(x.t), reason: CHANGED_SINCE });
      continue;
    }
    const err = restoreError(ctx, x.t, x.prior);
    if (err) {
      skipped.push({ ...label(x.t), reason: err });
      continue;
    }
    if (importedIntoProtected(ctx, x.t, x.prior, x.priorOrigin)) {
      skipped.push({ ...label(x.t), reason: NOT_IMPORTABLE });
      continue;
    }
    if ("commandId" in x.t) wanted.push({ commandId: x.t.commandId, chord: x.prior as string, of: x.of, origin: x.priorOrigin });
    else writes.push(restoreWrite(x.t, x.prior, x.of, ctx, x.priorOrigin));
  }
  const s = settle(state.keys, wanted, ctx.commands);
  for (const w of s.accepted) {
    const x = w as Wanted & { of: string; origin: ValueOrigin | undefined };
    writes.push(restoreWrite({ commandId: w.commandId }, w.chord, x.of, ctx, x.origin));
  }
  for (const w of s.rejected) skipped.push({ commandId: bound(w.commandId, LIMITS.id), reason: w.reason });
  const r = commit(state, writes, ctx, ctx.who, true);
  if ("ok" in r) return { ...r, skipped };
  if (r.entries.length === 0) return { ...fail(skipped.length ? "not-possible" : "already", skipped.length ? "Every setting in it was changed again since" : "It is already undone"), skipped };
  return { ok: true, ...r, skipped };
}
