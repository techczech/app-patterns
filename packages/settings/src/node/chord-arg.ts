/**
 * A shortcut typed on the command line, in the spelling the Settings window stores: modifiers in the order ⌘ ⌃ ⌥ ⇧, then the key, letters
 * upper case ("⌘⇧L"). Takes symbols ("⇧⌘l") or words joined by "+" ("cmd+shift+l", "ctrl+alt+enter"); "none" or "" is no shortcut.
 * Only the spelling is settled here; whether the chord may be used (reserved, taken, not a key the app knows) is the registry's call,
 * through the same whole-set check the window uses.
 */

const MOD_ORDER = ["⌘", "⌃", "⌥", "⇧"] as const;
const MOD_WORDS: Record<string, (typeof MOD_ORDER)[number]> = {
  cmd: "⌘", command: "⌘", meta: "⌘", super: "⌘", "⌘": "⌘",
  ctrl: "⌃", control: "⌃", "⌃": "⌃",
  alt: "⌥", opt: "⌥", option: "⌥", "⌥": "⌥",
  shift: "⇧", "⇧": "⇧",
};
const KEY_WORDS: Record<string, string> = {
  enter: "↵", return: "↵", esc: "Esc", escape: "Esc", tab: "⇥", space: "Space", up: "↑", down: "↓", left: "←", right: "→",
  backspace: "⌫", delete: "⌦", del: "⌦", comma: ",", period: ".", slash: "/", plus: "+", minus: "-",
};

export type ChordArg = { ok: true; chord: string } | { ok: false; error: string };

function keyOf(raw: string): string | null {
  const t = raw.trim();
  if (t === "") return null;
  const word = KEY_WORDS[t.toLowerCase()];
  if (word) return word;
  if (/^f([1-9]|1\d|2[0-4])$/i.test(t)) return t.toUpperCase();
  if ([...t].length === 1) return t.toUpperCase();
  return t; // a named key in its own spelling ("Space", "Esc"); the registry judges it
}

/** The canonical chord for `raw`, or why it is not one. */
export function parseChordArg(raw: string): ChordArg {
  const text = raw.trim();
  if (text === "" || text.toLowerCase() === "none") return { ok: true, chord: "" };
  const mods = new Set<string>();
  let key: string | null;
  if (text.length > 1 && text.includes("+")) {
    const parts = text.split("+");
    // "cmd++" ends in an empty part: the key is "+".
    const last = parts.at(-1) === "" && parts.at(-2) === "" ? "+" : parts.pop()!;
    if (last === "+") parts.splice(-2, 2);
    for (const p of parts) {
      const m = MOD_WORDS[p.trim().toLowerCase()];
      if (!m) return { ok: false, error: `"${p.trim().slice(0, 20)}" is not a modifier; use cmd, ctrl, alt or shift` };
      mods.add(m);
    }
    key = last === "+" ? "+" : keyOf(last);
  } else {
    let rest = text;
    while (rest.length > 0 && MOD_ORDER.includes(rest[0] as (typeof MOD_ORDER)[number])) {
      mods.add(rest[0]!);
      rest = rest.slice(1);
    }
    key = keyOf(rest);
  }
  if (!key) return { ok: false, error: "A shortcut needs a key after its modifiers" };
  return { ok: true, chord: MOD_ORDER.filter((m) => mods.has(m)).join("") + key };
}
