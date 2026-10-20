import { describe, expect, test } from "bun:test";
import type { StateCommand } from "@codemirror/state";
import type { Command } from "@codemirror/view";
import * as outline from "./index.ts";
import {
  deleteCurrentSection,
  indentListItem,
  jumpToNextHeading,
  jumpToPreviousHeading,
  lowerLineLevel,
  lowerSubtreeLevel,
  makeHeadingAtLevel,
  makeHeadingAtSurroundingLevel,
  makeHeadingOneLevelDeeper,
  moveBlockDown,
  moveBlockUp,
  moveSubtreeDown,
  moveSubtreeUp,
  outdentListItem,
  raiseLineLevel,
  raiseSubtreeLevel,
  selectCurrentSection,
} from "./index.ts";
import { invertText, positionOf, runCommand } from "./test-utils.ts";

const stateCommands: StateCommand[] = [
  deleteCurrentSection,
  indentListItem,
  jumpToNextHeading,
  jumpToPreviousHeading,
  lowerLineLevel,
  lowerSubtreeLevel,
  makeHeadingAtLevel(1),
  makeHeadingAtSurroundingLevel,
  makeHeadingOneLevelDeeper,
  moveBlockDown,
  moveBlockUp,
  moveSubtreeDown,
  moveSubtreeUp,
  outdentListItem,
  raiseLineLevel,
  raiseSubtreeLevel,
  selectCurrentSection,
];
const viewCommands: Command[] = stateCommands;

describe("move block", () => {
  test("a paragraph crosses a heading and the inverse restores byte-identical text", () => {
    const text = "# One\nfirst paragraph\n\n# Two\nsecond paragraph";
    const moved = runCommand(moveBlockDown, text, positionOf(text, "first paragraph"));
    expect(moved.state.doc.toString()).toBe("# One\n# Two\nfirst paragraph\n\nsecond paragraph");
    expect(moved.transactions).toHaveLength(1);
    expect(moved.state.doc.lineAt(moved.state.selection.main.head).text).toBe("first paragraph");

    const restored = runCommand(moveBlockUp, moved.state.doc.toString(), moved.state.selection.main.head);
    expect(restored.state.doc.toString()).toBe(text);
  });

  test("a paragraph at the end of the document is a consumed no-op", () => {
    const text = "# One\nlast paragraph";
    const result = runCommand(moveBlockDown, text, positionOf(text, "last paragraph"));
    expect(result.handled).toBe(true);
    expect(result.state.doc.toString()).toBe(text);
    expect(result.transactions).toHaveLength(0);
  });

  test("a heading moves as one line and leaves its body behind", () => {
    const text = "# One\nbody\n# Two\nlast";
    const moved = runCommand(moveBlockDown, text, positionOf(text, "# One"));
    expect(moved.state.doc.toString()).toBe("body\n# One\n# Two\nlast");
    expect(moved.state.doc.lineAt(moved.state.selection.main.head).text).toBe("# One");
  });

  test("a list item moves alone past its child and re-parents that child", () => {
    const text = "- parent\n- moving\n  - child\n- last";
    const moved = runCommand(moveBlockDown, text, positionOf(text, "moving"));
    expect(moved.state.doc.toString()).toBe("- parent\n  - child\n- moving\n- last");
    expect(moved.state.doc.lineAt(moved.state.selection.main.head).text).toBe("- moving");
  });

  test("a list item does not move out of its list into unrelated prose", () => {
    const text = "- one\n- two\n\nunrelated prose";
    const moved = runCommand(moveBlockDown, text, positionOf(text, "two"));
    expect(moved.state.doc.toString()).toBe(text);
    expect(moved.transactions).toHaveLength(0);
  });

  test("a fenced block is opaque to block movement", () => {
    const text = "before\n\n```md\n# fenced heading\n- fenced list\n```\n\nafter";
    const moved = runCommand(moveBlockDown, text, positionOf(text, "fenced heading"));
    expect(moved.state.doc.toString()).toBe("before\n\nafter\n\n```md\n# fenced heading\n- fenced list\n```");
  });
});

test("the outline package exposes movement with the current subtree", () => {
  expect(typeof (outline as Record<string, unknown>).moveSubtreeUp).toBe("function");
  expect(typeof (outline as Record<string, unknown>).moveSubtreeDown).toBe("function");
});

describe("move with subtree", () => {
  test("a heading takes its body and subheadings", () => {
    const text = "# One\nbody\n## Child\nchild body\n# Two\nlast";
    const moved = runCommand(moveSubtreeDown, text, positionOf(text, "# One"));
    expect(moved.state.doc.toString()).toBe("# Two\nlast\n# One\nbody\n## Child\nchild body");
    expect(moved.transactions).toHaveLength(1);
    expect(moved.state.doc.lineAt(moved.state.selection.main.head).text).toBe("# One");
  });

  test("body text moves its enclosing section", () => {
    const text = "# One\nbody\n## Child\nchild body\n# Two\nlast";
    const moved = runCommand(moveSubtreeDown, text, positionOf(text, "body"));
    expect(moved.state.doc.toString()).toBe("# Two\nlast\n# One\nbody\n## Child\nchild body");
    expect(moved.state.doc.lineAt(moved.state.selection.main.head).text).toBe("body");
  });

  test("a list item takes its descendants", () => {
    const text = "- parent\n- moving\n  - child\n- last";
    const moved = runCommand(moveSubtreeDown, text, positionOf(text, "moving"));
    expect(moved.state.doc.toString()).toBe("- parent\n- last\n- moving\n  - child");
  });

  for (const [name, command] of [
    ["block up", moveBlockUp],
    ["block down", moveBlockDown],
    ["subtree up", moveSubtreeUp],
    ["subtree down", moveSubtreeDown],
  ] as const) {
    test(`${name} never crosses front matter`, () => {
      const text = "---\ntitle: kept\n---\n# One\nbody";
      const fromFrontmatter = runCommand(command, text, positionOf(text, "title"));
      expect(fromFrontmatter.state.doc.toString()).toBe(text);
      expect(fromFrontmatter.transactions).toHaveLength(0);

      if (name.endsWith("up")) {
        const fromFirstBodyBlock = runCommand(command, text, positionOf(text, "# One"));
        expect(fromFirstBodyBlock.state.doc.toString()).toBe(text);
        expect(fromFirstBodyBlock.transactions).toHaveLength(0);
      }
    });
  }

  test("a fenced hash is not a section boundary", () => {
    const text = "# One\nbody\n```md\n# fenced heading\n```\n# Two\nlast";
    const moved = runCommand(moveSubtreeDown, text, positionOf(text, "body"));
    expect(moved.state.doc.toString()).toBe("# Two\nlast\n# One\nbody\n```md\n# fenced heading\n```");
  });
});

describe("change level", () => {
  const cases: Array<{
    name: string;
    command: StateCommand;
    inverse: StateCommand;
    input: string;
    caret: string;
    output: string;
  }> = [
    {
      name: "raise current heading line",
      command: raiseLineLevel,
      inverse: lowerLineLevel,
      input: "# Parent\n### Child\n#### Grandchild\nbody",
      caret: "Child",
      output: "# Parent\n## Child\n#### Grandchild\nbody",
    },
    {
      name: "lower current heading line",
      command: lowerLineLevel,
      inverse: raiseLineLevel,
      input: "# Parent\n## Child\n### Grandchild\nbody",
      caret: "Child",
      output: "# Parent\n### Child\n### Grandchild\nbody",
    },
    {
      name: "raise heading subtree",
      command: raiseSubtreeLevel,
      inverse: lowerSubtreeLevel,
      input: "# Parent\n### Child\n#### Grandchild\nbody\n## Sibling",
      caret: "Child",
      output: "# Parent\n## Child\n### Grandchild\nbody\n## Sibling",
    },
    {
      name: "lower heading subtree",
      command: lowerSubtreeLevel,
      inverse: raiseSubtreeLevel,
      input: "# Parent\n## Child\n### Grandchild\nbody\n## Sibling",
      caret: "Child",
      output: "# Parent\n### Child\n#### Grandchild\nbody\n## Sibling",
    },
  ];

  for (const item of cases) {
    test(`${item.name} changes exactly the claimed markers in one transaction`, () => {
      const result = runCommand(item.command, item.input, positionOf(item.input, item.caret));
      expect(result.state.doc.toString()).toBe(item.output);
      expect(result.transactions).toHaveLength(1);
    });

    test(`${item.name} round-trips byte-identically with its inverse`, () => {
      const changed = runCommand(item.command, item.input, positionOf(item.input, item.caret));
      const restored = runCommand(
        item.inverse,
        changed.state.doc.toString(),
        changed.state.selection.main.head,
      );
      expect(restored.state.doc.toString()).toBe(item.input);
    });
  }

  test("line-only list lowering does not touch descendants", () => {
    const text = "- parent\n\t- tab child\n    - space child";
    const result = runCommand(lowerLineLevel, text, positionOf(text, "parent"));
    expect(result.state.doc.toString()).toBe("  - parent\n\t- tab child\n    - space child");
  });

  test("list subtree lowering and raising preserve mixed indentation byte-for-byte", () => {
    const text = "- parent\n\t- tab child\n    - space child";
    const lowered = runCommand(lowerSubtreeLevel, text, positionOf(text, "parent"));
    expect(lowered.state.doc.toString()).toBe(
      "  - parent\n  \t- tab child\n      - space child",
    );
    const raised = runCommand(raiseSubtreeLevel, lowered.state.doc.toString(), lowered.state.selection.main.head);
    expect(raised.state.doc.toString()).toBe(text);
  });

  test("setext heading levels change without converting their text or normalising whitespace", () => {
    const text = "Title  \n-----\nbody";
    const raised = runCommand(raiseLineLevel, text, positionOf(text, "Title"));
    expect(raised.state.doc.toString()).toBe("Title  \n=====\nbody");
    const restored = runCommand(lowerLineLevel, raised.state.doc.toString(), raised.state.selection.main.head);
    expect(restored.state.doc.toString()).toBe(text);
  });

  for (const [name, command] of [
    ["raise line", raiseLineLevel],
    ["lower line", lowerLineLevel],
    ["raise subtree", raiseSubtreeLevel],
    ["lower subtree", lowerSubtreeLevel],
  ] as const) {
    test(`${name} leaves front matter and fenced markers untouched`, () => {
      const text = "---\n# metadata\n---\n```md\n## fake\n  - fake\n```\n## Real";
      for (const caret of ["metadata", "## fake", "- fake"]) {
        const result = runCommand(command, text, positionOf(text, caret));
        expect(result.handled).toBe(true);
        expect(result.state.doc.toString()).toBe(text);
        expect(result.transactions).toHaveLength(0);
      }
    });
  }

  test("a subtree level change is wholly rejected when any heading would exceed level six", () => {
    const text = "##### Root\n###### Child";
    const result = runCommand(lowerSubtreeLevel, text, positionOf(text, "Root"));
    expect(result.state.doc.toString()).toBe(text);
    expect(result.transactions).toHaveLength(0);
  });
});

describe("make heading", () => {
  test("sets an existing heading to the explicit level and preserves all other bytes", () => {
    const text = "before  \n## Candidate  \nafter\n";
    const result = runCommand(makeHeadingAtLevel(4), text, positionOf(text, "Candidate"));
    expect(result.state.doc.toString()).toBe("before  \n#### Candidate  \nafter\n");
    expect(result.transactions).toHaveLength(1);
    expect(invertText(result)).toBe(text);
  });

  test("turns a list item into an explicit level-six heading", () => {
    const text = "before\n  - Candidate  \nafter";
    const result = runCommand(makeHeadingAtLevel(6), text, positionOf(text, "Candidate"));
    expect(result.state.doc.toString()).toBe("before\n###### Candidate  \nafter");
    expect(result.transactions).toHaveLength(1);
    expect(invertText(result)).toBe(text);
  });

  test("turns a quote line into an explicit heading", () => {
    const text = "before\n> Candidate\nafter";
    const result = runCommand(makeHeadingAtLevel(3), text, positionOf(text, "Candidate"));
    expect(result.state.doc.toString()).toBe("before\n### Candidate\nafter");
    expect(result.transactions).toHaveLength(1);
    expect(invertText(result)).toBe(text);
  });

  test("explicit heading level is a consumed no-op inside a fenced code block", () => {
    const text = "before\n```md\n- Candidate\n```\nafter";
    const result = runCommand(makeHeadingAtLevel(4), text, positionOf(text, "Candidate"));
    expect(result.handled).toBe(true);
    expect(result.state.doc.toString()).toBe(text);
    expect(result.transactions).toHaveLength(0);
  });

  test("uses the surrounding heading level and strips combined quote/list markers", () => {
    const text = "## Surrounding\n> - candidate  \nend";
    const result = runCommand(
      makeHeadingAtSurroundingLevel,
      text,
      positionOf(text, "candidate"),
    );
    expect(result.state.doc.toString()).toBe("## Surrounding\n## candidate  \nend");
    expect(result.transactions).toHaveLength(1);
    expect(invertText(result)).toBe(text);
  });

  test("uses one level deeper and ignores heading-looking fenced code", () => {
    const text = "# Real\n```md\n##### fake\n```\n- candidate";
    const result = runCommand(makeHeadingOneLevelDeeper, text, positionOf(text, "candidate"));
    expect(result.state.doc.toString()).toBe("# Real\n```md\n##### fake\n```\n## candidate");
    expect(invertText(result)).toBe(text);
  });

  test("replaces a setext underline as part of the same undoable change", () => {
    const text = "# Parent\nCandidate\n---------\nbody";
    const result = runCommand(makeHeadingOneLevelDeeper, text, positionOf(text, "Candidate"));
    expect(result.state.doc.toString()).toBe("# Parent\n## Candidate\nbody");
    expect(result.transactions).toHaveLength(1);
    expect(invertText(result)).toBe(text);
  });

  for (const [name, command] of [
    ["surrounding-level variant", makeHeadingAtSurroundingLevel],
    ["one-deeper variant", makeHeadingOneLevelDeeper],
  ] as const) {
    test(`${name} is a consumed no-op inside front matter and fences`, () => {
      const text = "---\ntitle: candidate\n---\n```\ncandidate in fence\n```";
      for (const caret of ["title", "candidate in fence"]) {
        const result = runCommand(command, text, positionOf(text, caret));
        expect(result.handled).toBe(true);
        expect(result.state.doc.toString()).toBe(text);
        expect(result.transactions).toHaveLength(0);
      }
    });
  }
});

describe("heading navigation", () => {
  const text = "---\n# metadata\n---\nTitle\n=====\n```md\n# fake\n```\n## Real\n# Last";

  test("next jumps to setext and ATX headings while skipping front matter and fences", () => {
    const first = runCommand(jumpToNextHeading, text, positionOf(text, "metadata"));
    expect(first.state.selection.main.head).toBe(positionOf(text, "Title"));
    expect(first.transactions).toHaveLength(1);
    const second = runCommand(jumpToNextHeading, text, first.state.selection.main.head);
    expect(second.state.selection.main.head).toBe(positionOf(text, "## Real"));
  });

  test("previous is the exact inverse of next for the text and caret", () => {
    const next = runCommand(jumpToNextHeading, text, positionOf(text, "## Real"));
    const previous = runCommand(jumpToPreviousHeading, text, next.state.selection.main.head);
    expect(previous.state.doc.toString()).toBe(text);
    expect(previous.state.selection.main.head).toBe(positionOf(text, "## Real"));
  });

  test("previous and next at their respective edges are consumed no-ops", () => {
    const previous = runCommand(jumpToPreviousHeading, text, positionOf(text, "Title"));
    const next = runCommand(jumpToNextHeading, text, positionOf(text, "# Last"));
    expect(previous.transactions).toHaveLength(0);
    expect(next.transactions).toHaveLength(0);
    expect(previous.handled).toBe(true);
    expect(next.handled).toBe(true);
  });
});

describe("section commands", () => {
  const text = "# One\nbody\n## Empty\n# Two\nlast";

  test("select current section selects the heading and body in one transaction", () => {
    const result = runCommand(selectCurrentSection, text, positionOf(text, "body"));
    expect(result.state.sliceDoc(result.state.selection.main.from, result.state.selection.main.to)).toBe(
      "# One\nbody\n## Empty\n",
    );
    expect(result.transactions).toHaveLength(1);
    expect(result.state.doc.toString()).toBe(text);
  });

  test("delete current section removes exactly that range in one invertible transaction", () => {
    const result = runCommand(deleteCurrentSection, text, positionOf(text, "body"));
    expect(result.state.doc.toString()).toBe("# Two\nlast");
    expect(result.transactions).toHaveLength(1);
    expect(invertText(result)).toBe(text);
  });

  test("section commands ignore front matter and fenced fake headings", () => {
    const fixture = "---\ntitle: x\n---\n# Real\n```\n# fake\n```\nbody";
    const selected = runCommand(selectCurrentSection, fixture, positionOf(fixture, "fake"));
    expect(selected.state.sliceDoc(selected.state.selection.main.from, selected.state.selection.main.to)).toBe(
      "# Real\n```\n# fake\n```\nbody",
    );
    const protectedResult = runCommand(deleteCurrentSection, fixture, positionOf(fixture, "title"));
    expect(protectedResult.state.doc.toString()).toBe(fixture);
    expect(protectedResult.transactions).toHaveLength(0);
  });
});

describe("list indentation", () => {
  const text = "- parent\n- first\n\t- tab child\n    - space child\n- second";

  function expectListLevelChange(
    command: StateCommand,
    before: string,
    caret: string,
    after: string,
  ): void {
    const result = runCommand(command, before, positionOf(before, caret));
    expect(result.state.doc.toString()).toBe(after);
    expect(result.transactions).toHaveLength(1);

    const contentAfterMarker = (document: string): string[] =>
      document.split("\n").flatMap((line) => {
        const match = line.match(/^[ \t]*(?:[-+*]|\d+[.)])([ \t]+.*)$/);
        return match?.[1] === undefined ? [] : [match[1]];
      });
    expect(contentAfterMarker(result.state.doc.toString())).toEqual(contentAfterMarker(before));
  }

  test("indent renumbers the joined and departed ordered runs", () => {
    const before = "1. a\n2. b\n3. c";
    const after = "1. a\n  1. b\n2. c";

    expectListLevelChange(indentListItem, before, "b", after);
  });

  test("outdent renumbers the joined and departed ordered runs", () => {
    const before = "1. a\n  1. b\n2. c";
    const after = "1. a\n2. b\n3. c";

    expectListLevelChange(outdentListItem, before, "b", after);
  });

  test("indent joins an existing child run after deeper items", () => {
    const before = "1. a\n  1. x\n2. b";
    const after = "1. a\n  1. x\n  2. b";

    expectListLevelChange(indentListItem, before, "b", after);
  });

  test("outdent leaves an existing child run and rejoins its parent run", () => {
    const before = "1. a\n  1. x\n  2. b";
    const after = "1. a\n  1. x\n2. b";

    expectListLevelChange(outdentListItem, before, "b", after);
  });

  test("outdent starts a new outer run at one when no outer sibling precedes it", () => {
    const before = "   1. x\n   2. y";
    const after = "   1. x\n 1. y";

    expectListLevelChange(outdentListItem, before, "y", after);
  });

  test("indent rejoins the nested run from the derived outdent example", () => {
    const before = "   1. x\n 1. y";
    const after = "   1. x\n   2. y";

    expectListLevelChange(indentListItem, before, "y", after);
  });

  test("a departed ordered run keeps its authored start number", () => {
    const before = "5. a\n6. b\n7. c";
    const after = "5. a\n  1. b\n6. c";

    expectListLevelChange(indentListItem, before, "b", after);
  });

  test("renumbering preserves each ordered item's delimiter", () => {
    const before = "1) a\n2. b\n3) c";
    const after = "1) a\n  1. b\n2) c";

    expectListLevelChange(indentListItem, before, "b", after);
  });

  test("bullet indentation changes only subtree whitespace", () => {
    const before = "- a\n- b\n  * child\n+ c";
    const indented = "- a\n  - b\n    * child\n+ c";

    expectListLevelChange(indentListItem, before, "b", indented);
    expectListLevelChange(outdentListItem, indented, "b", before);
  });

  test("ordered parents renumber while moved bullet children keep their markers", () => {
    const before = "1. a\n2. b\n  - child\n3. c";
    const after = "1. a\n  1. b\n    - child\n2. c";

    expectListLevelChange(indentListItem, before, "b", after);
  });

  test("a moved item's ordered children keep their own numbering", () => {
    const before = "1. a\n2. b\n  5. child one\n  6) child two\n3. c";
    const after = "1. a\n  1. b\n    5. child one\n    6) child two\n2. c";

    expectListLevelChange(indentListItem, before, "b", after);
  });

  test("an unrelated ordered list remains byte-identical", () => {
    const before = "# First\n1. a\n2. b\n3. c\n\n# Unrelated\n9) untouched one\n13. untouched two";
    const after = "# First\n1. a\n  1. b\n2. c\n\n# Unrelated\n9) untouched one\n13. untouched two";

    expectListLevelChange(indentListItem, before, "b", after);
  });

  test("indent contains a marker-only item to its own line", () => {
    const fixture = "- Test\n- ";
    const result = runCommand(indentListItem, fixture, fixture.indexOf("\n- ") + 1);

    expect(result.state.doc.toString()).toBe("- Test\n  - ");
  });

  test("indent leaves a separate nested list below a marker-only item byte-identical", () => {
    const fixture = "- Test\n- \n\n- Separate\n  - nested";
    const result = runCommand(indentListItem, fixture, fixture.indexOf("\n- ") + 1);

    expect(result.state.doc.toString()).toBe("- Test\n  - \n\n- Separate\n  - nested");
  });

  test("outdent leaves a separate nested list below a marker-only item byte-identical", () => {
    const fixture = "- Test\n  - \n\n- Separate\n  - nested";
    const result = runCommand(outdentListItem, fixture, fixture.indexOf("\n  - ") + 1);

    expect(result.state.doc.toString()).toBe("- Test\n- \n\n- Separate\n  - nested");
  });

  test("indent changes a list item and descendants in one transaction, then outdent restores bytes", () => {
    const indented = runCommand(indentListItem, text, positionOf(text, "first"));
    expect(indented.state.doc.toString()).toBe(
      "- parent\n  - first\n  \t- tab child\n      - space child\n- second",
    );
    expect(indented.transactions).toHaveLength(1);
    const restored = runCommand(
      outdentListItem,
      indented.state.doc.toString(),
      indented.state.selection.main.head,
    );
    expect(restored.state.doc.toString()).toBe(text);
  });

  test("outdent changes only the selected nested subtree, then indent restores bytes", () => {
    const nested = "- parent\n  - child\n    - grandchild\n- sibling";
    const outdented = runCommand(outdentListItem, nested, positionOf(nested, "child"));
    expect(outdented.state.doc.toString()).toBe(
      "- parent\n- child\n  - grandchild\n- sibling",
    );
    const restored = runCommand(
      indentListItem,
      outdented.state.doc.toString(),
      outdented.state.selection.main.head,
    );
    expect(restored.state.doc.toString()).toBe(nested);
  });

  test("indent changes every partially selected sibling and preserves the selection", () => {
    const fixture = "- a\n- b\n";
    const anchor = 0;
    const head = 7;
    const result = runCommand(indentListItem, fixture, { anchor, head });

    expect(result.handled).toBe(true);
    expect(result.state.doc.toString()).toBe("  - a\n  - b\n");
    expect(result.transactions).toHaveLength(1);
    expect(result.state.doc.lineAt(result.state.selection.main.from).text).toBe("  - a");
    expect(result.state.doc.lineAt(result.state.selection.main.to).text).toBe("  - b");
    expect(result.state.selection.main.anchor < result.state.selection.main.head).toBe(true);
    expect(invertText(result)).toBe(fixture);
  });

  test("indent changes selected items at different depths with each subtree", () => {
    const fixture = "- first\n  - child\n- second\n  - second child\n- last";
    const anchor = positionOf(fixture, "child");
    const head = positionOf(fixture, "- second") + "- second".length;
    const result = runCommand(indentListItem, fixture, { anchor, head });

    expect(result.state.doc.toString()).toBe(
      "- first\n    - child\n  - second\n    - second child\n- last",
    );
    expect(result.transactions).toHaveLength(1);
    expect(result.state.doc.lineAt(result.state.selection.main.from).text).toBe("    - child");
    expect(result.state.doc.lineAt(result.state.selection.main.to).text).toBe("  - second");
  });

  test("indent moves a selected parent and its selected child only once", () => {
    const fixture = "- parent\n  - child\n    - grandchild\n- sibling";
    const anchor = positionOf(fixture, "parent");
    const head = positionOf(fixture, "child") + "child".length;
    const result = runCommand(indentListItem, fixture, { anchor, head });

    expect(result.state.doc.toString()).toBe(
      "  - parent\n    - child\n      - grandchild\n- sibling",
    );
    expect(result.transactions).toHaveLength(1);
  });

  test("outdent changes every selected sibling and preserves the selection", () => {
    const fixture = "- parent\n  - one\n  - two\n- last";
    const anchor = positionOf(fixture, "one");
    const head = positionOf(fixture, "two") + "two".length;
    const result = runCommand(outdentListItem, fixture, { anchor, head });

    expect(result.handled).toBe(true);
    expect(result.state.doc.toString()).toBe("- parent\n- one\n- two\n- last");
    expect(result.transactions).toHaveLength(1);
    expect(result.state.doc.lineAt(result.state.selection.main.from).text).toBe("- one");
    expect(result.state.doc.lineAt(result.state.selection.main.to).text).toBe("- two");
    expect(result.state.selection.main.anchor < result.state.selection.main.head).toBe(true);
  });

  test("outdent at the outermost level returns false without dispatching", () => {
    const fixture = "- top\n";
    const result = runCommand(outdentListItem, fixture, positionOf(fixture, "top"));

    expect(result.handled).toBe(false);
    expect(result.state.doc.toString()).toBe(fixture);
    expect(result.transactions).toHaveLength(0);
  });

  test("indent changes a first item even without a preceding sibling", () => {
    const fixture = "- first\n  - child\n- second";
    const result = runCommand(indentListItem, fixture, positionOf(fixture, "first"));

    expect(result.handled).toBe(true);
    expect(result.state.doc.toString()).toBe("  - first\n    - child\n- second");
    expect(result.transactions).toHaveLength(1);
  });

  test("indent changes an already nested item with no preceding sibling", () => {
    const fixture = "  - first\n  - second";
    const result = runCommand(indentListItem, fixture, positionOf(fixture, "first"));

    expect(result.handled).toBe(true);
    expect(result.state.doc.toString()).toBe("    - first\n  - second");
    expect(result.transactions).toHaveLength(1);
  });

  for (const [name, command] of [
    ["indent", indentListItem],
    ["outdent", outdentListItem],
  ] as const) {
    test(`${name} returns false without dispatching outside a real list`, () => {
      const fixture = "paragraph\n```\n- fake\n```";
      for (const caret of ["paragraph", "fake"]) {
        const result = runCommand(command, fixture, positionOf(fixture, caret));
        expect(result.handled).toBe(false);
        expect(result.state.doc.toString()).toBe(fixture);
        expect(result.transactions).toHaveLength(0);
      }
    });
  }
});

test("state commands remain directly usable as view commands", () => {
  expect(viewCommands).toHaveLength(stateCommands.length);
});
