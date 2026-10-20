import { describe, expect, test } from "bun:test";
import { buildOrder, planRun, runOrdered } from "./run-workspaces.mjs";

const pkg = (name, deps = {}, scripts = { build: "x", check: "x" }) => ({
  name,
  dependencies: deps,
  scripts,
});

describe("buildOrder", () => {
  test("puts dependencies first and ignores external deps", () => {
    const order = buildOrder([pkg("b", { a: "*", zod: "1" }), pkg("a"), pkg("c", { b: "*" })]);
    expect(order).toEqual(["a", "b", "c"]);
  });
  test("is alphabetical within a tier", () => {
    expect(buildOrder([pkg("z"), pkg("m"), pkg("a")])).toEqual(["a", "m", "z"]);
  });
  test("throws on a cycle", () => {
    expect(() => buildOrder([pkg("a", { b: "*" }), pkg("b", { a: "*" })])).toThrow(/cycle/);
  });
});

describe("planRun", () => {
  test("skips packages without the script", () => {
    const ms = [pkg("b", { a: "*" }), pkg("a", {}, { check: "x" }), pkg("c", { b: "*" }, {})];
    expect(planRun(ms, "build")).toEqual(["b"]);
    expect(planRun(ms, "check")).toEqual(["a", "b"]);
  });
});

describe("runOrdered", () => {
  const ws = [pkg("b", { a: "*" }), pkg("a")].map((manifest) => ({ dir: manifest.name, manifest }));
  test("runs in dependency order", () => {
    const seen = [];
    const result = runOrdered(ws, "check", (w) => (seen.push(w.manifest.name), 0));
    expect(result).toEqual({ ok: true });
    expect(seen).toEqual(["a", "b"]);
  });
  test("stops at the first failure and names the package", () => {
    const seen = [];
    const result = runOrdered(ws, "check", (w) => (seen.push(w.manifest.name), 3));
    expect(result).toEqual({ ok: false, failed: "a", status: 3 });
    expect(seen).toEqual(["a"]);
  });
});
