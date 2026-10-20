import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Every module the pure entry reaches through relative imports, with what each one imports. */
function reach(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    const text = readFileSync(file, "utf8");
    const specs = [...text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
    seen.set(file, specs);
    for (const s of specs) if (s.startsWith(".")) walk(resolve(dirname(file), s));
  };
  walk(entry);
  return seen;
}

describe("the pure entry", () => {
  it("imports no node: module and no package, directly or through its own modules", () => {
    const graph = reach(join(import.meta.dir, "index.ts"));
    expect(graph.size).toBeGreaterThan(5);
    for (const [file, specs] of graph) {
      expect(file.includes(`${"/"}node${"/"}`)).toBe(false);
      for (const s of specs) expect({ file, s, relative: s.startsWith(".") }).toEqual({ file, s, relative: true });
    }
  });

  it("the node entry is a separate subpath export", () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));
    expect(pkg.exports["./node"].import).toBe("./dist/node/index.js");
    expect(pkg.exports["."].import).toBe("./dist/index.js");
  });
});
