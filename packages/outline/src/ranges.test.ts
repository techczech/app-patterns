import { describe, expect, test } from "bun:test";
import { getNodeRange, getSectionRange } from "./index.ts";

function at(text: string, needle: string, offset = 0): number {
  const position = text.indexOf(needle);
  if (position < 0) throw new Error(`Missing fixture text: ${needle}`);
  return position + offset;
}

function selected(text: string, range: { from: number; to: number }): string {
  return text.slice(range.from, range.to);
}

describe("getNodeRange", () => {
  test("classifies an ATX heading as its section through the next same-or-shallower heading", () => {
    const text = "# One\nbody\n## Child\nchild\n# Two\nend";
    const range = getNodeRange(text, at(text, "# One"));
    expect(range).toEqual({ from: 0, to: at(text, "# Two"), kind: "heading", level: 1 });
    expect(selected(text, range)).toBe("# One\nbody\n## Child\nchild\n");
  });

  test("recognises setext headings and consecutive headings of changing depth", () => {
    const text = "Title\n=====\n## Child\n### Grandchild\n# Next";
    expect(getNodeRange(text, at(text, "Title"))).toEqual({
      from: 0,
      to: at(text, "# Next"),
      kind: "heading",
      level: 1,
    });
    expect(selected(text, getNodeRange(text, at(text, "## Child")))).toBe(
      "## Child\n### Grandchild\n",
    );
  });

  test("treats a marker-only list item after another list item as its own list block", () => {
    const text = "- Test\n- ";
    expect(getNodeRange(text, at(text, "\n- ", 1))).toEqual({
      from: 7,
      to: text.length,
      kind: "list",
      level: 0,
    });
  });

  test("still recognises hyphen and equals setext headings after paragraph content", () => {
    for (const [text, level] of [
      ["Some paragraph\n---", 2],
      ["Some paragraph\n===", 1],
    ] as const) {
      expect(getNodeRange(text, 0)).toEqual({
        from: 0,
        to: text.length,
        kind: "heading",
        level,
      });
    }
  });

  test("classifies a nested list item with mixed tab and space indentation as one subtree", () => {
    const text = "- parent\n\t- tab child\n\t  - space grandchild\n- sibling";
    const range = getNodeRange(text, at(text, "parent"));
    expect(range.kind).toBe("list");
    expect(range.level).toBe(0);
    expect(selected(text, range)).toBe("- parent\n\t- tab child\n\t  - space grandchild\n");
  });

  test("classifies a continuation line as part of its containing list item", () => {
    const text = "- item\n  continuation line\n  - child\n- sibling";
    const range = getNodeRange(text, at(text, "continuation"));
    expect(range.kind).toBe("list");
    expect(selected(text, range)).toBe("- item\n  continuation line\n  - child\n");
  });

  test("returns a whole paragraph block rather than a single wrapped line", () => {
    const text = "first line\nsecond line\n\nnext paragraph";
    expect(selected(text, getNodeRange(text, at(text, "second")))).toBe(
      "first line\nsecond line",
    );
  });

  test("treats a fenced code block as one opaque paragraph block", () => {
    const text = "before\n\n```md\n# not a heading\n- not a list\n```\n\nafter";
    const range = getNodeRange(text, at(text, "# not"));
    expect(range.kind).toBe("paragraph");
    expect(selected(text, range)).toBe("```md\n# not a heading\n- not a list\n```");
  });

  test("preserves a final block when the text has no trailing newline", () => {
    const text = "# Heading\nfinal paragraph";
    const range = getNodeRange(text, at(text, "final"));
    expect(range.to).toBe(text.length);
    expect(selected(text, range)).toBe("final paragraph");
  });
});

describe("getSectionRange", () => {
  test("finds the containing section from its body and handles a heading with no body", () => {
    const text = "# One\nbody\n## Empty\n# Two";
    expect(selected(text, getSectionRange(text, at(text, "body"))!)).toBe(
      "# One\nbody\n## Empty\n",
    );
    expect(selected(text, getSectionRange(text, at(text, "Empty"))!)).toBe("## Empty\n");
  });

  test("ignores heading-shaped lines inside fences in both boundary directions", () => {
    const text = "# Real\n```md\n# fake\n```\nstill real\n# Next";
    expect(selected(text, getSectionRange(text, at(text, "fake"))!)).toBe(
      "# Real\n```md\n# fake\n```\nstill real\n",
    );
  });

  test("returns null inside YAML front matter", () => {
    const text = "---\ntitle: # metadata\n---\n# Body";
    expect(getSectionRange(text, at(text, "metadata"))).toBeNull();
  });
});
