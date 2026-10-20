import { describe, expect, test } from "bun:test";
import { whoView } from "./model.ts";

const w = (x: unknown) => whoView(x as Parameters<typeof whoView>[0]);

describe("whoView", () => {
  test("names the known actors", () => {
    expect(w({ kind: "you" })).toEqual({ kind: "you", label: "You" });
    expect(w({ kind: "agent", name: "Codex" })).toEqual({ kind: "agent", label: "Codex" });
    expect(w({ kind: "app-update", version: "0.31.0" })).toEqual({ kind: "app-update", label: "Update 0.31.0" });
    expect(w({ kind: "import" })).toEqual({ kind: "import", label: "Import" });
  });
  test("an app update without a version is still an app update", () => {
    expect(w({ kind: "app-update" })).toEqual({ kind: "app-update", label: "App update" });
  });
  test("an unknown kind is neutral, never You", () => {
    expect(w({ kind: "scheduler" }).label).toBe("Other");
    expect(w({ kind: "scheduler" }).kind).toBe("other");
    expect(w({ kind: "reset", by: { kind: "scheduler" } }).label).toBe("Other");
    expect(w({ kind: "reset", by: { kind: "agent", name: "Codex" } }).label).toBe("Codex");
  });
});
