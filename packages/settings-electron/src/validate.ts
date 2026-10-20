/**
 * Checks on every argument that arrives over IPC. A renderer is not trusted: each value must have the right type and size, and keys,
 * command ids and sections must be ones the app declares. Returns the cleaned value or null; never echoes what it was given.
 */
import type { Schema, SettingValue } from "@app-patterns/settings";

export const MAX_ID_CHARS = 200;
export const MAX_CHORD_CHARS = 32;
export const MAX_TEXT_CHARS = 4096;
export const MAX_PAIRS = 500;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

export function idArg(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_ID_CHARS && !CONTROL.test(v) ? v : null;
}

/** A setting key the schema declares, not a secret (a key's value never travels on `set`). */
export function settingKeyArg(schema: Schema, v: unknown): string | null {
  const key = idArg(v);
  if (key === null) return null;
  const def = schema.def(key);
  return def && def.type !== "secret" ? key : null;
}

/** A plain JSON primitive of a sane size. The store checks it against the setting's type and rules. */
export function valueArg(v: unknown): SettingValue | null {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") return v.length <= MAX_TEXT_CHARS ? v : null;
  return null;
}

export function commandIdArg(isCommand: (id: string) => boolean, v: unknown): string | null {
  const id = idArg(v);
  return id !== null && isCommand(id) ? id : null;
}

/** A chord as typed ("" removes the shortcut). Its shape is the registry's to judge. */
export function chordArg(v: unknown): string | null {
  return typeof v === "string" && v.length <= MAX_CHORD_CHARS && !CONTROL.test(v) ? v : null;
}

export function pairsArg(isCommand: (id: string) => boolean, v: unknown): { commandId: string; chord: string }[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_PAIRS) return null;
  const out: { commandId: string; chord: string }[] = [];
  for (const p of v) {
    if (!isPlainObject(p) || Object.keys(p).some((k) => k !== "commandId" && k !== "chord")) return null;
    const commandId = commandIdArg(isCommand, p.commandId);
    const chord = chordArg(p.chord);
    if (commandId === null || chord === null) return null;
    out.push({ commandId, chord });
  }
  return out;
}

/** A setting key, or `{ commandId }` for a shortcut. */
export function resetTargetArg(schema: Schema, isCommand: (id: string) => boolean, v: unknown): string | { commandId: string } | null {
  if (typeof v === "string") return settingKeyArg(schema, v);
  if (!isPlainObject(v)) return null;
  const keys = Object.keys(v);
  if (keys.length !== 1 || keys[0] !== "commandId") return null;
  const commandId = commandIdArg(isCommand, v.commandId);
  return commandId === null ? null : { commandId };
}

export function sectionArg(schema: Schema, extra: readonly string[], v: unknown): string | null {
  const id = idArg(v);
  if (id === null) return null;
  return schema.section(id) !== undefined || extra.includes(id) ? id : null;
}

/** A path setting's key (for the folder picker). */
export function pathKeyArg(schema: Schema, v: unknown): string | null {
  const key = idArg(v);
  return key !== null && schema.def(key)?.type === "path" ? key : null;
}

/** A file name as the window got it from `importPreview`. */
export function fileNameArg(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= 1024 && !CONTROL.test(v) ? v : null;
}

/** A key typed into Accounts and keys: a string of sane size. The slot checks its shape. */
export function secretValueArg(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_TEXT_CHARS ? v : null;
}
