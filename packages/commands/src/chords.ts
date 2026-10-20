/**
 * A chord is a shortcut written the way the menu and the cheat sheet show it: modifiers in the order ⌘ ⌃ ⌥ ⇧, then the key ("⌘⇧P", "⌥↵", "↓").
 * The key comes from the physical key (`code`), so a chord means the same on any keyboard layout. Pure: no DOM, no Electron.
 */
export type Chord = string;

const MODS = ["⌘", "⌃", "⌥", "⇧"] as const;
const KEY_OF_CODE: Record<string, string> = {
  Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'", Backslash: "\\", BracketLeft: "[", BracketRight: "]", Backquote: "`",
  Equal: "=", Minus: "-", Enter: "↵", NumpadEnter: "↵", Backspace: "⌫", Delete: "⌦", Tab: "⇥", Space: "Space",
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Escape: "Esc",
};

/** Every key name a chord may end in: letters, digits, F1–F24 and the named keys above. Nothing else is a key here. */
export const SUPPORTED_KEYS: ReadonlySet<string> = new Set([
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  ...Object.values(KEY_OF_CODE),
]);

/**
 * A chord in the supported grammar: each modifier at most once, in the fixed order (⌘ ⌃ ⌥ ⇧), then exactly one supported key name.
 * No control characters, no stray text. Letters must already be upper case (the canonical spelling). "" (no shortcut) is not a chord here.
 */
export function isValidChord(chord: unknown): chord is Chord {
  if (typeof chord !== "string" || chord.length === 0 || chord.length > 12) return false;
  if (/[\u0000-\u001f\u007f-\u009f]/.test(chord)) return false;
  const m = /^(⌘?)(⌃?)(⌥?)(⇧?)(.+)$/u.exec(chord);
  return !!m && SUPPORTED_KEYS.has(m[5]!);
}

/** The modifiers of a chord as a set, and its key. */
export function splitChord(chord: Chord): { mods: string[]; key: string } {
  return { mods: MODS.filter((m) => chord.includes(m)), key: chord.replace(/[⌃⌥⇧⌘]/g, "") };
}

/** One spelling per chord: modifiers in the fixed order, key upper-cased. Empty for an empty or key-less chord. */
export function canonChord(chord: string): Chord {
  const { mods, key } = splitChord(chord.trim());
  if (!key) return "";
  return mods.join("") + (key.length === 1 ? key.toUpperCase() : key);
}

export interface KeyLike {
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** The chord a key press makes; null for a modifier on its own or a key with no name here. */
export function chordFromEvent(e: KeyLike): Chord | null {
  let key = KEY_OF_CODE[e.code];
  if (!key) {
    if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
    else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
    else if (/^F\d{1,2}$/.test(e.code)) key = e.code;
    else return null;
  }
  return (e.metaKey ? "⌘" : "") + (e.ctrlKey ? "⌃" : "") + (e.altKey ? "⌥" : "") + (e.shiftKey ? "⇧" : "") + key;
}

/** A chord a new binding may use: it has ⌘, ⌃ or ⌥ (or is a function key), so it cannot be mistaken for typing. */
export function isTypingSafe(chord: Chord): boolean {
  const { mods, key } = splitChord(chord);
  return mods.some((m) => m !== "⇧") || /^F\d{1,2}$/.test(key);
}

const ACCEL_KEY: Record<string, string> = { "↑": "Up", "↓": "Down", "←": "Left", "→": "Right", "↵": "Return", "⌫": "Backspace", "⌦": "Delete", "⇥": "Tab", Space: "Space", Esc: "Escape" };

/** The Electron accelerator for the menu's display of this chord ("Delete", "F5", "Down", "R" for a bare key); null only for an empty or key-less chord. */
export function toAccelerator(chord: Chord): string | null {
  const { mods, key } = splitChord(chord);
  if (!key) return null;
  const parts = mods.map((m) => ({ "⌘": "Cmd", "⌃": "Ctrl", "⌥": "Alt", "⇧": "Shift" })[m]!);
  parts.push(ACCEL_KEY[key] ?? key);
  return parts.join("+");
}
