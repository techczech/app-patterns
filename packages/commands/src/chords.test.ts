import { describe, expect, test } from "bun:test";
import { canonChord, chordFromEvent, isTypingSafe, isValidChord, toAccelerator } from "./chords.ts";
import { FIXTURE_DEFS } from "./fixture.ts";

const ev = (code: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) => ({ code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

describe("chords", () => {
  test("names a key press by its physical key and the modifiers in fixed order", () => {
    expect(chordFromEvent(ev("KeyP", { metaKey: true, shiftKey: true }))).toBe("⌘⇧P");
    expect(chordFromEvent(ev("Digit1", { metaKey: true, altKey: true }))).toBe("⌘⌥1");
    expect(chordFromEvent(ev("Comma", { metaKey: true, shiftKey: true }))).toBe("⌘⇧,");
    expect(chordFromEvent(ev("Backspace", { metaKey: true }))).toBe("⌘⌫");
    expect(chordFromEvent(ev("ArrowDown"))).toBe("↓");
    expect(chordFromEvent(ev("Enter", { altKey: true }))).toBe("⌥↵");
    expect(chordFromEvent(ev("F5"))).toBe("F5");
  });
  test("gives no chord for a modifier on its own", () => {
    expect(chordFromEvent(ev("MetaLeft", { metaKey: true }))).toBeNull();
    expect(chordFromEvent(ev("ShiftLeft", { shiftKey: true }))).toBeNull();
  });
  test("writes one spelling per chord", () => {
    expect(canonChord("⇧⌘p")).toBe("⌘⇧P");
    expect(canonChord("⌘")).toBe("");
    expect(canonChord(" ")).toBe("");
  });
  test("accepts only chords that cannot be mistaken for typing", () => {
    for (const c of ["⌘R", "⌥↵", "F5"]) expect(isTypingSafe(c)).toBe(true);
    for (const c of ["R", "⇧R", "↓"]) expect(isTypingSafe(c)).toBe(false);
  });
  test("maps chords to Electron accelerators", () => {
    expect(toAccelerator("⌘⇧P")).toBe("Cmd+Shift+P");
    expect(toAccelerator("⌘⌫")).toBe("Cmd+Backspace");
    expect(toAccelerator("⌥↵")).toBe("Alt+Return");
    expect(toAccelerator("⌘⌃⌥⇧F12")).toBe("Cmd+Ctrl+Alt+Shift+F12");
    expect(toAccelerator("⌘,")).toBe("Cmd+,");
    expect(toAccelerator("⌘↑")).toBe("Cmd+Up");
    expect(toAccelerator("F5")).toBe("F5");
    expect(toAccelerator("F12")).toBe("F12");
    expect(toAccelerator("⇧F6")).toBe("Shift+F6");
    expect(toAccelerator("↓")).toBe("Down");
    expect(toAccelerator("")).toBeNull();
  });
  test("gives a valid accelerator for an unmodified key of every family", () => {
    const want: Record<string, string> = {
      "⌦": "Delete", "⌫": "Backspace", "F5": "F5", "F24": "F24", "Space": "Space", "R": "R", "7": "7", "↵": "Return", "⇥": "Tab", "Esc": "Escape",
      "↑": "Up", "↓": "Down", "←": "Left", "→": "Right", ",": ",", ".": ".", "/": "/", ";": ";", "'": "'", "[": "[", "]": "]", "`": "`", "=": "=", "-": "-",
    };
    for (const [chord, accel] of Object.entries(want)) { expect(isValidChord(chord)).toBe(true); expect(toAccelerator(chord)).toBe(accel); }
    expect(toAccelerator("⇧⌦")).toBe("Shift+Delete");
    expect(toAccelerator("⇧R")).toBe("Shift+R");
  });
});

describe("chord grammar", () => {
  test("accepts modifiers in order plus one supported key", () => {
    for (const c of ["⌘⇧P", "⌥↵", "↓", "⌘⌃⌥⇧F12", "⌘Space", "Esc", "⌘,", "⌘1"]) expect(isValidChord(c)).toBe(true);
  });
  test("refuses control characters, unknown keys, two keys, repeated or misordered modifiers and non-strings", () => {
    for (const c of ["", "⌘\u0001", "⌘A\n", "⌘\u007f", "⌘AB", "⌘Hello", "⌘⌘A", "⇧⌘A", "⌘a", "⌘F25", "⌘", "⌘é", "⌘<script>", 5, null]) expect(isValidChord(c)).toBe(false);
  });
  test("covers every chord a key press can make and every default in a registry", () => {
    for (const code of ["KeyA", "Digit0", "F1", "F24", "Comma", "Enter", "ArrowUp", "Escape", "Space", "Backquote"])
      expect(isValidChord(chordFromEvent(ev(code, { metaKey: true, altKey: true })))).toBe(true);
    for (const def of FIXTURE_DEFS) if (def.key) expect(isValidChord(canonChord(def.key))).toBe(true);
  });
});
