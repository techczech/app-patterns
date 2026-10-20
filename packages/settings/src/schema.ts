/**
 * The settings schema: every setting declared once (key, label, section, type, default, validation). The window rows, search, reset,
 * changelog, CLI and export are all generated from it (invariant 2). Values are plain JSON primitives so the file stays hand-readable.
 */

export type SettingType = "toggle" | "choice" | "text" | "number" | "path" | "chord" | "secret";
export type SettingValue = string | number | boolean;

export interface ChoiceOption {
  value: SettingValue;
  label: string;
}

/** What `canApply` is given during an import preview; the app supplies it (for example `pathExists`). */
export interface ApplyEnv {
  pathExists?(path: string): boolean;
  [name: string]: unknown;
}

export interface SettingDef {
  key: string;
  label: string;
  /** A shared section id (`general`, `appearance`, `shortcuts`, `accounts`) or one of the app's section ids. */
  section: string;
  /** Card heading inside the section. */
  group?: string;
  type: SettingType;
  /** `null` for `secret` (secrets are never stored in the settings file). */
  default: SettingValue | null;
  /** Required for `choice`. */
  options?: readonly ChoiceOption[];
  /** For `number`. */
  min?: number;
  max?: number;
  /** Shown after a number value ("×", "pt"); used by `formatValue`. */
  unit?: string;
  /** Extra rule after the type check; a string is the reason shown. */
  validate?(v: SettingValue): string | null;
  help?: string;
  /** Whether an imported value can apply on this machine (a folder that does not exist here); a string is the skip reason. */
  canApply?(v: SettingValue, env: ApplyEnv): string | null;
  /**
   * `false`: an import never applies this setting (it stays as it is on this Mac, whatever the file holds); the preview lists it as
   * skipped with the reason `NOT_IMPORTABLE`. Default true. Export still writes it, so the file is a full record.
   */
  importable?: boolean;
}

/** The skip reason an import gives for a setting declared `importable: false`. */
export const NOT_IMPORTABLE = "not importable";

export interface SectionDef {
  id: string;
  label: string;
  /** lucide icon name. */
  icon: string;
}

export interface Section extends SectionDef {
  /** One of the shared sections every app has. */
  shared: boolean;
  /** Changes and About, pinned at the foot of the sidebar. */
  pinned: boolean;
}

/** The shared sections, in sidebar order: four under "All apps", then the app's sections, then Changes and About pinned at the bottom. */
export const SHARED_SECTIONS = {
  general: { id: "general", label: "General", icon: "settings" },
  appearance: { id: "appearance", label: "Appearance", icon: "palette" },
  shortcuts: { id: "shortcuts", label: "Shortcuts", icon: "keyboard" },
  accounts: { id: "accounts", label: "Accounts and keys", icon: "key-round" },
  changes: { id: "changes", label: "Changes", icon: "clipboard-list" },
  about: { id: "about", label: "About", icon: "info" },
} as const satisfies Record<string, SectionDef>;
export type SharedSectionId = keyof typeof SHARED_SECTIONS;
const TOP_SHARED: SharedSectionId[] = ["general", "appearance", "shortcuts", "accounts"];
const PINNED: SharedSectionId[] = ["changes", "about"];

export interface Schema {
  /** The app id written into the settings file and every export ("editorexample"). */
  app: string;
  /** Every section in sidebar order. */
  sections: readonly Section[];
  /** Every setting in declared order. */
  settings: readonly SettingDef[];
  def(key: string): SettingDef | undefined;
  section(id: string): Section | undefined;
}

export class SchemaError extends Error {}

export interface SchemaInput {
  app: string;
  /** The app's own sections, in the order the sidebar lists them. */
  sections?: readonly SectionDef[];
  settings: readonly SettingDef[];
}

/** Checks a schema once at start-up and indexes it. Throws `SchemaError` on a programming mistake (duplicate key, bad default, unknown section). */
export function defineSchema(input: SchemaInput): Schema {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(input.app)) throw new SchemaError(`app id "${input.app}" must be lower case letters, digits, . _ -`);
  const own = input.sections ?? [];
  const sections: Section[] = [
    ...TOP_SHARED.map((id) => ({ ...SHARED_SECTIONS[id], shared: true, pinned: false })),
    ...own.map((s) => ({ ...s, shared: false, pinned: false })),
    ...PINNED.map((id) => ({ ...SHARED_SECTIONS[id], shared: true, pinned: true })),
  ];
  const sectionById = new Map<string, Section>();
  for (const s of sections) {
    if (sectionById.has(s.id)) throw new SchemaError(`section "${s.id}" is declared twice`);
    sectionById.set(s.id, s);
  }
  const byKey = new Map<string, SettingDef>();
  for (const d of input.settings) {
    if (!d.key || byKey.has(d.key)) throw new SchemaError(`setting key "${d.key}" is empty or declared twice`);
    if (d.key.length > 200 || d.key === "changes") throw new SchemaError(`setting key "${d.key}" is too long or reserved`);
    const section = sectionById.get(d.section);
    if (!section || section.pinned) throw new SchemaError(`setting "${d.key}" names section "${d.section}", which settings cannot live in`);
    if (d.importable !== undefined && typeof d.importable !== "boolean") throw new SchemaError(`setting "${d.key}": importable must be true or false`);
    if (d.type === "choice" && !(d.options && d.options.length > 0)) throw new SchemaError(`choice setting "${d.key}" has no options`);
    if (d.type === "secret") {
      if (d.default !== null) throw new SchemaError(`secret setting "${d.key}" must have default null`);
    } else {
      const err = d.default === null ? "has no default" : checkValue(d, d.default);
      if (err) throw new SchemaError(`setting "${d.key}" default: ${err}`);
    }
    byKey.set(d.key, d);
  }
  return {
    app: input.app,
    sections,
    settings: [...input.settings],
    def: (key) => byKey.get(key),
    section: (id) => sectionById.get(id),
  };
}

const MAX_TEXT = 4096;
const MAX_CHORD = 32;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Basic shape of a stored chord: "" (none) or a short string without control characters. The command registry judges the rest. */
export function chordShapeError(chord: unknown): string | null {
  if (typeof chord !== "string") return "A shortcut must be text";
  if (chord.length > MAX_CHORD || CONTROL.test(chord)) return "That is not a key combination";
  return null;
}

/** Why `value` cannot be this setting's value, or null when it can. */
export function checkValue(def: SettingDef, value: unknown): string | null {
  switch (def.type) {
    case "secret":
      return "Keys are kept in Keychain, never in the settings file";
    case "toggle":
      if (typeof value !== "boolean") return "Must be on or off";
      break;
    case "choice":
      if (!def.options?.some((o) => o.value === value)) return "Not one of the choices";
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return "Must be a number";
      if (def.min !== undefined && value < def.min) return `Must be at least ${def.min}`;
      if (def.max !== undefined && value > def.max) return `Must be at most ${def.max}`;
      break;
    case "text":
      if (typeof value !== "string") return "Must be text";
      if (value.length > MAX_TEXT || value.includes("\u0000")) return "That text cannot be saved";
      break;
    case "path":
      if (typeof value !== "string") return "Must be a path";
      if (value.length > MAX_TEXT || CONTROL.test(value)) return "That path cannot be saved";
      break;
    case "chord": {
      const e = chordShapeError(value);
      if (e) return e;
      break;
    }
  }
  return def.validate?.(value as SettingValue) ?? null;
}

export type ParseResult = { ok: true; value: SettingValue } | { ok: false; error: string };

/** Turns typed text (a CLI argument) into a value for this setting, then checks it. Choices match by value or by label. */
export function parseValue(def: SettingDef, raw: string): ParseResult {
  let value: SettingValue;
  switch (def.type) {
    case "secret":
      return { ok: false, error: "Keys are set in Accounts and keys, not here" };
    case "toggle": {
      const t = raw.trim().toLowerCase();
      if (["on", "true", "yes", "1"].includes(t)) value = true;
      else if (["off", "false", "no", "0"].includes(t)) value = false;
      else return { ok: false, error: "Must be on or off" };
      break;
    }
    case "number": {
      const n = raw.trim() === "" ? Number.NaN : Number(raw);
      if (!Number.isFinite(n)) return { ok: false, error: "Must be a number" };
      value = n;
      break;
    }
    case "choice": {
      const t = raw.trim();
      const o = def.options?.find((x) => String(x.value) === t) ?? def.options?.find((x) => x.label.toLowerCase() === t.toLowerCase());
      if (!o) return { ok: false, error: `Not one of the choices: ${(def.options ?? []).map((x) => String(x.value)).join(", ")}` };
      value = o.value;
      break;
    }
    default:
      value = raw;
  }
  const err = checkValue(def, value);
  return err ? { ok: false, error: err } : { ok: true, value };
}

/** A value in the user's words: On/Off, a choice's label, a number with its unit, "None" for no shortcut, "—" for no value. */
export function formatValue(def: SettingDef | undefined, value: SettingValue | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (!def) return String(value);
  switch (def.type) {
    case "toggle":
      return value ? "On" : "Off";
    case "choice":
      return def.options?.find((o) => o.value === value)?.label ?? String(value);
    case "number":
      return def.unit ? `${value} ${def.unit}` : String(value);
    case "chord":
      return value === "" ? "None" : String(value);
    default:
      return String(value);
  }
}
