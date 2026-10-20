import { expect, test } from "bun:test";
import { parseChordArg } from "./chord-arg.ts";

test("parseChordArg: words or symbols, in the window's spelling", () => {
  const ok = (raw: string) => {
    const r = parseChordArg(raw);
    if (!r.ok) throw new Error(r.error);
    return r.chord;
  };
  expect(ok("cmd+shift+l")).toBe("⌘⇧L");
  expect(ok("Shift+Cmd+L")).toBe("⌘⇧L");
  expect(ok("⇧⌘l")).toBe("⌘⇧L");
  expect(ok("ctrl+alt+enter")).toBe("⌃⌥↵");
  expect(ok("opt+cmd+space")).toBe("⌘⌥Space");
  expect(ok("cmd+f12")).toBe("⌘F12");
  expect(ok("cmd++")).toBe("⌘+");
  expect(ok("none")).toBe("");
  expect(ok(" ")).toBe("");
  expect(parseChordArg("hyper+j").ok).toBe(false);
  expect(parseChordArg("cmd+").ok).toBe(false);
});
