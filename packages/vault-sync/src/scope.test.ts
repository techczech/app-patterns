import { describe, expect, test } from "bun:test";
import { compilePattern, compileScope } from "./scope.ts";

describe("scope patterns", () => {
  const matches = (pattern: string, path: string) => compilePattern(pattern).regex.test(path);

  test("literal paths name a file or a whole directory", () => {
    expect(matches("notes", "notes")).toBe(true);
    expect(matches("notes", "notes/a/b.md")).toBe(true);
    expect(matches("notes", "notes-old/a.md")).toBe(false);
    expect(matches("a b/c.md", "a b/c.md")).toBe(true);
  });

  test("* and ? stay inside a segment; ** spans segments", () => {
    expect(matches("notes/*.md", "notes/a.md")).toBe(true);
    expect(matches("notes/*.md", "notes/x/a.md")).toBe(false);
    expect(matches("notes/**/*.md", "notes/a.md")).toBe(true);
    expect(matches("notes/**/*.md", "notes/x/y/a.md")).toBe(true);
    expect(matches("**/*.tmp", "a/b/c.tmp")).toBe(true);
    expect(matches("**/*.tmp", "c.tmp")).toBe(true);
    expect(matches("drafts/**", "drafts")).toBe(true);
    expect(matches("file?.md", "file1.md")).toBe(true);
    expect(matches("file[0-9].md", "file7.md")).toBe(true);
    expect(matches("file[!0-9].md", "file7.md")).toBe(false);
    expect(matches("*.md", "new\nline.md")).toBe(true);
  });

  test("walk base is the leading literal directory", () => {
    expect(compilePattern("notes/sub/*.md").base).toBe("notes/sub");
    expect(compilePattern("**/*.md").base).toBe("");
    expect(compilePattern("notes/a.md").base).toBe("notes/a.md");
  });

  test("absolute, parent and empty patterns are refused", () => {
    for (const bad of ["/etc", "../x", "a/../b", "", "a//b", "C:/x"]) expect(() => compilePattern(bad)).toThrow();
    expect(() => compileScope({ include: [] })).toThrow();
  });

  test(".git is always excluded", () => {
    const scope = compileScope({ include: ["**"] });
    expect(scope.isExcluded(".git/config")).toBe(true);
    expect(scope.isExcluded("sub/.git")).toBe(true);
    expect(scope.isExcluded("notes/.gitignore")).toBe(false);
  });
});
