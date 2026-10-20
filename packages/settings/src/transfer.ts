/**
 * Moving settings between Macs by hand: export writes one file (format v1) with the settings changed from default and the shortcut
 * overrides, never secrets (invariant 5). Import is a preview (what will change, what is skipped and why, how many already match) and
 * then one batch, attributed to the file, that Undo import reverses. A preview's shortcut rows are exactly those the whole-set
 * resolution accepts, so applying an unchanged state's preview always succeeds.
 */
import { bound, LIMITS, MAX_CHANGES, type Actor, type ImportWho, type SkippedItem } from "./changes.ts";
import { commandIdError, overrideError, settle, type CommandsAdapter, type Wanted } from "./keys.ts";
import { checkValue, NOT_IMPORTABLE, type ApplyEnv, type Schema, type SettingValue } from "./schema.ts";
import { chordOf, commit, fail, valueOf, type Clock, type OpResult, type SettingsState, type Write } from "./state.ts";

export const EXPORT_FORMAT = "bridle-settings-export";
export const EXPORT_VERSION = 1;

export interface ExportFile {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  app: string;
  appVersion: string;
  /** The Mac's name. */
  exportedFrom: string;
  /** ISO 8601. */
  exportedAt: string;
  settings: Record<string, SettingValue>;
  keys: Record<string, string>;
}

export interface ExportOptions {
  appVersion: string;
  hostName: string;
  /** ms since 1970. */
  now: number;
  /** Only settings the schema knows and that are not secrets are written. */
  schema: Schema;
  /** Only overrides for registry commands are written. */
  commands: CommandsAdapter;
}

/** The export file for this state. */
export function exportFile(state: SettingsState, opts: ExportOptions): ExportFile {
  const settings: Record<string, SettingValue> = {};
  for (const [key, value] of Object.entries(state.settings)) {
    const def = opts.schema.def(key);
    if (!def || def.type === "secret") continue;
    settings[key] = value;
  }
  const keys: Record<string, string> = {};
  for (const [id, chord] of Object.entries(state.keys)) if (commandIdError(id, opts.schema, opts.commands) === null) keys[id] = chord;
  return {
    format: EXPORT_FORMAT, version: EXPORT_VERSION, app: state.app, appVersion: opts.appVersion, exportedFrom: opts.hostName,
    exportedAt: new Date(opts.now).toISOString(), settings, keys,
  };
}

export interface ImportEnv {
  schema: Schema;
  commands: CommandsAdapter;
  /** Given to each setting's `canApply` (for example `pathExists`). */
  apply?: ApplyEnv;
}

export interface ImportChange {
  /** A setting key, or `commandId` for a shortcut. */
  key?: string;
  commandId?: string;
  from: SettingValue | null;
  to: SettingValue;
  section: string;
}

export type RefusedCode = "unparsable" | "wrong-format" | "other-app" | "newer-version" | "too-many";
export interface Refused {
  code: RefusedCode;
  message: string;
  /** For `other-app`: the app the file is from. */
  app?: string;
}

export interface ImportPreview {
  changes: ImportChange[];
  /** Identifiers bounded to the changelog's limits. */
  skipped: SkippedItem[];
  alreadyMatch: number;
  refused?: Refused;
  /** From the file, for the preview sheet and the batch: which app version and Mac exported it, and when. */
  source?: { app: string; appVersion?: string; exportedFrom?: string; exportedAt?: string };
}

const refuse = (code: RefusedCode, message: string, app?: string): ImportPreview => ({
  changes: [], skipped: [], alreadyMatch: 0, refused: { code, message, ...(app !== undefined ? { app } : {}) },
});
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const optStr = (v: unknown): string | undefined => (typeof v === "string" ? bound(v, LIMITS.name) : undefined);
const skipKey = (key: string, reason: string): SkippedItem => ({ key: bound(key, LIMITS.id), reason: bound(reason, LIMITS.text) });
const skipCmd = (commandId: string, reason: string): SkippedItem => ({ commandId: bound(commandId, LIMITS.id), reason: bound(reason, LIMITS.text) });

/** What importing `file` (its text, or the parsed JSON) would do to `state`. Never throws. */
export function previewImport(state: SettingsState, file: unknown, env: ImportEnv): ImportPreview {
  let raw = file;
  if (typeof file === "string") {
    try {
      raw = JSON.parse(file);
    } catch {
      return refuse("unparsable", "This file could not be read as a settings file");
    }
  }
  if (!isRecord(raw)) return refuse("unparsable", "This file could not be read as a settings file");
  if (raw.format !== EXPORT_FORMAT) return refuse("wrong-format", "This is not an exported settings file");
  if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) return refuse("wrong-format", "This is not an exported settings file");
  if (raw.version > EXPORT_VERSION) return refuse("newer-version", "This file was exported by a newer version of the app; update the app first");
  if (raw.app !== state.app) {
    const other = optStr(raw.app);
    return refuse("other-app", other ? `These are settings for ${other}, not for this app` : "These settings are for another app", other);
  }
  const settings = isRecord(raw.settings) ? raw.settings : {};
  const keys = isRecord(raw.keys) ? raw.keys : {};
  const preview: ImportPreview = {
    changes: [], skipped: [], alreadyMatch: 0,
    source: { app: state.app, ...pick("appVersion", raw.appVersion), ...pick("exportedFrom", raw.exportedFrom), ...pick("exportedAt", raw.exportedAt) },
  };
  for (const [key, value] of Object.entries(settings)) {
    const def = env.schema.def(key);
    if (!def) {
      preview.skipped.push(skipKey(key, "This version of the app has no such setting"));
      continue;
    }
    if (def.type === "secret") {
      preview.skipped.push(skipKey(key, "Keys are never imported"));
      continue;
    }
    if (def.importable === false) {
      preview.skipped.push(skipKey(key, NOT_IMPORTABLE));
      continue;
    }
    const err = checkValue(def, value);
    if (err) {
      preview.skipped.push(skipKey(key, err));
      continue;
    }
    const v = value as SettingValue;
    const from = valueOf(state, env.schema, key);
    if (from === v) {
      preview.alreadyMatch++;
      continue;
    }
    const cannot = def.canApply?.(v, env.apply ?? {}) ?? null;
    if (cannot) {
      preview.skipped.push(skipKey(key, cannot));
      continue;
    }
    preview.changes.push({ key, from, to: v, section: def.section });
  }
  const wanted: Wanted[] = [];
  for (const [commandId, chord] of Object.entries(keys)) {
    const idErr = commandIdError(commandId, env.schema, env.commands);
    if (idErr) {
      preview.skipped.push(skipCmd(commandId, env.schema.def(commandId) ? idErr : "This version of the app has no such command"));
      continue;
    }
    const err = overrideError(commandId, chord, env.schema, env.commands);
    if (err) {
      preview.skipped.push(skipCmd(commandId, err));
      continue;
    }
    if (chordOf(state, commandId, env.commands) === chord) {
      preview.alreadyMatch++;
      continue;
    }
    wanted.push({ commandId, chord: chord as string });
  }
  const s = settle(state.keys, wanted, env.commands);
  const accepted = new Set(s.accepted.map((w) => w.commandId));
  for (const w of wanted) {
    if (accepted.has(w.commandId)) preview.changes.push({ commandId: w.commandId, from: chordOf(state, w.commandId, env.commands), to: w.chord!, section: "shortcuts" });
  }
  for (const w of s.rejected) preview.skipped.push(skipCmd(w.commandId, w.reason));
  if (preview.changes.length > MAX_CHANGES) return refuse("too-many", `This file would change ${preview.changes.length} settings; at most ${MAX_CHANGES} can be imported at once`);
  return preview;
}

function pick<K extends string>(k: K, v: unknown): Partial<Record<K, string>> {
  const s = optStr(v);
  return s === undefined ? {} : ({ [k]: s } as Record<K, string>);
}

export interface ApplyImportContext extends Clock {
  schema: Schema;
  commands: CommandsAdapter;
  /** Who ran the import, when not you (an agent through the CLI). */
  by?: Actor;
}

/**
 * Applies a preview as one batch, one entry per setting changed, `who: import` with the file's name. Each value is checked again (a
 * setting declared `importable: false` is refused too) and the resulting shortcut set is judged whole, so a schema or state that changed
 * since the preview, or a preview built by hand, cannot slip a bad value in.
 */
export function applyImport(state: SettingsState, preview: ImportPreview, opts: { file: string }, ctx: ApplyImportContext): OpResult {
  if (preview.refused) return fail("not-possible", preview.refused.message);
  const writes: Write[] = [];
  for (const c of preview.changes) {
    if (c.key !== undefined) {
      const def = ctx.schema.def(c.key);
      if (!def || def.type === "secret" || def.importable === false || checkValue(def, c.to) !== null) return fail("invalid-value", `"${c.key}" can no longer take that value`);
      writes.push({ target: { key: c.key }, to: c.to });
    } else if (c.commandId !== undefined) {
      if (overrideError(c.commandId, c.to, ctx.schema, ctx.commands) !== null) return fail("invalid-chord", `"${c.commandId}" can no longer take that shortcut`);
      writes.push({ target: { commandId: c.commandId }, to: c.to });
    }
  }
  const src = preview.source ?? { app: state.app };
  const who: ImportWho = {
    kind: "import", file: bound(opts.file, LIMITS.file),
    ...pick("exportedFrom", src.exportedFrom), ...pick("exportedAt", src.exportedAt), ...pick("appVersion", src.appVersion),
  };
  if (preview.skipped.length) {
    who.skipped = preview.skipped.slice(0, LIMITS.skipped).map((s) => (s.key !== undefined ? skipKey(s.key, s.reason) : skipCmd(s.commandId ?? "", s.reason)));
  }
  if (ctx.by && ctx.by.kind !== "you") who.by = ctx.by;
  const r = commit(state, writes, ctx, who, true);
  return "ok" in r ? r : { ok: true, ...r };
}
