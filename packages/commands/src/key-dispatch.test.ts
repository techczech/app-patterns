import { describe, expect, test } from "bun:test";
import { splitChord } from "./chords.ts";
import { defineRegistry } from "./registry.ts";
import { fixture } from "./fixture.ts";
import { dispatchKey } from "./key-dispatch.ts";

const r = fixture;

const CODES: Record<string, string> = { ",": "Comma", "/": "Slash", "=": "Equal", "-": "Minus", "↵": "Enter", "⌫": "Backspace", "↓": "ArrowDown", "↑": "ArrowUp", "→": "ArrowRight" };
const code = (key: string): string => (/^[A-Z]$/.test(key) ? `Key${key}` : /^\d$/.test(key) ? `Digit${key}` : CODES[key]!);
function press(chord: string) {
  const { mods, key } = splitChord(chord);
  return { code: code(key), metaKey: mods.includes("⌘"), ctrlKey: mods.includes("⌃"), altKey: mods.includes("⌥"), shiftKey: mods.includes("⇧") };
}
const free = { inField: false, onControl: false, overlay: false };
const b = r.bindingsOf();

describe("key dispatch", () => {
  test("runs every command on its own default chord when nothing has focus", () => {
    for (const d of r.defs.filter((c) => c.key)) expect(dispatchKey(r, press(d.key), b, free)).toBe(d.id);
  });
  test("inside a text field runs only commands the registry allows while typing", () => {
    for (const d of r.defs.filter((c) => c.key)) expect(dispatchKey(r, press(d.key), b, { ...free, inField: true })).toBe(r.runsWhileTyping(d.id) ? d.id : null);
  });
  test("follows a rebinding and drops the old chord", () => {
    const rb = r.bindingsOf({ rename: "⌘⌥R" });
    expect(dispatchKey(r, press("⌘⌥R"), rb, free)).toBe("rename");
    expect(dispatchKey(r, press("⌘R"), rb, free)).toBeNull();
    expect(dispatchKey(r, press("⌘⌥R"), rb, { ...free, inField: true })).toBeNull();
  });
  test("leaves Return to a focused button; an open overlay lets only the overlay commands through", () => {
    expect(dispatchKey(r, press("↵"), b, { ...free, onControl: true })).toBeNull();
    expect(dispatchKey(r, press("↵"), b, free)).toBe("open");
    expect(dispatchKey(r, press("⌘D"), b, { ...free, overlay: true })).toBeNull();
    expect(dispatchKey(r, press("⌘⇧P"), b, { ...free, overlay: true })).toBe("palette");
  });
  test("ignores a key with no command or a lone modifier", () => {
    expect(dispatchKey(r, press("⌘J"), b, free)).toBeNull();
    expect(dispatchKey(r, { code: "MetaLeft", metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, b, free)).toBeNull();
  });
  test("a scoped chord shadows the global one only while its scope is active", () => {
    const sr = defineRegistry<"G", void>([
      { id: "refresh", group: "G", label: "Refresh", key: "F5", icon: "x" },
      { id: "trash", group: "G", label: "Trash", key: "⌦", icon: "x", scope: "list" },
      { id: "row-refresh", group: "G", label: "Refresh row", key: "F5", icon: "x", scope: "list" },
    ]);
    const sb = sr.bindingsOf();
    const f5 = { code: "F5", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
    expect(dispatchKey(sr, f5, sb, free)).toBe("refresh");
    expect(dispatchKey(sr, f5, sb, { ...free, scope: "other" })).toBe("refresh");
    expect(dispatchKey(sr, f5, sb, { ...free, scope: "list" })).toBe("row-refresh");
    const del = { ...f5, code: "Delete" };
    expect(dispatchKey(sr, del, sb, free)).toBeNull();
    expect(dispatchKey(sr, del, sb, { ...free, scope: "list" })).toBe("trash");
  });
  test("a bare chord never runs inside a text field, even for a typing command", () => {
    const sr = defineRegistry<"G", void>([{ id: "jump", group: "G", label: "Jump", key: "⌘J", icon: "x", scope: "list", typing: true }]);
    const sb = sr.bindingsOf({ jump: "X" });
    const x = { code: "KeyX", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
    expect(sr.checkRebind(sr.bindingsOf(), "jump", "X").kind).toBe("typing");
    // a stored or hand-made binding still cannot fire from a field
    expect(dispatchKey(sr, x, { jump: "X" }, { ...free, scope: "list" })).toBe("jump");
    expect(dispatchKey(sr, x, { jump: "X" }, { ...free, scope: "list", inField: true })).toBeNull();
    expect(sb.jump).toBe("⌘J");
    expect(dispatchKey(sr, { ...x, metaKey: true, code: "KeyJ" }, sb, { ...free, scope: "list", inField: true })).toBe("jump");
  });
});
