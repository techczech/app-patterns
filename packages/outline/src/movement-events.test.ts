import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { installDom } from "./dom.test-support.ts";
import {
  moveBlockDown,
  moveBlockUp,
  moveSubtreeDown,
  moveSubtreeUp,
} from "./commands.ts";
import { getNodeRange, getSectionRange } from "./ranges.ts";

const openViews: EditorView[] = [];
let cleanupDom: () => void;

beforeEach(() => {
  cleanupDom = installDom();
  window.requestAnimationFrame = (callback: FrameRequestCallback): number =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number;
  window.cancelAnimationFrame = (handle: number): void => clearTimeout(handle);
});

afterEach(() => {
  for (const view of openViews.splice(0)) view.destroy();
  cleanupDom();
});

const movementKeys = keymap.of([
  { key: "Ctrl-Meta-ArrowUp", run: moveBlockUp },
  { key: "Ctrl-Meta-ArrowDown", run: moveBlockDown },
  { key: "Ctrl-Shift-Meta-ArrowUp", run: moveSubtreeUp },
  { key: "Ctrl-Shift-Meta-ArrowDown", run: moveSubtreeDown },
]);

function focusedEditor(
  text: string,
  needle: string,
  onDocumentChange?: () => void,
): EditorView {
  const position = text.indexOf(needle);
  if (position < 0) throw new Error(`Missing fixture text: ${needle}`);
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      selection: EditorSelection.cursor(position),
      extensions: [
        movementKeys,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onDocumentChange?.();
        }),
      ],
    }),
  });
  openViews.push(view);
  view.focus();
  expect(view.hasFocus).toBe(true);
  return view;
}

function rangeText(
  text: string,
  range: { from: number; to: number } | null,
): string {
  if (!range) throw new Error("Expected a structural range");
  return text.slice(range.from, range.to);
}

function pressMovementKey(
  view: EditorView,
  direction: "up" | "down",
  withSubtree: boolean,
): void {
  const event = new KeyboardEvent("keydown", {
    key: direction === "up" ? "ArrowUp" : "ArrowDown",
    ctrlKey: true,
    metaKey: true,
    shiftKey: withSubtree,
    bubbles: true,
    cancelable: true,
  });
  view.contentDOM.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
}

describe("movement through a focused editor key event", () => {
  test("a blank-separated top-level section moves down and back up byte-identically", () => {
    const text = "# One\none\n\n# Two\ntwo";
    const view = focusedEditor(text, "# One");

    pressMovementKey(view, "down", true);
    expect(view.state.doc.toString()).toBe("# Two\ntwo\n\n# One\none");
    expect(view.state.doc.lineAt(view.state.selection.main.head).text).toBe("# One");

    pressMovementKey(view, "up", true);
    expect(view.state.doc.toString()).toBe(text);
  });

  test("a subsection moves down after destination prose and before its first subheading", () => {
    const text = "## First\nintro\n\n### Moving\nmoving\n\n## Next\nnext prose\n\n### Existing\nexisting";
    let documentChanges = 0;
    const view = focusedEditor(text, "### Moving", () => {
      documentChanges += 1;
    });

    pressMovementKey(view, "down", true);
    const moved = view.state.doc.toString();
    expect(moved).toBe(
      "## First\nintro\n\n## Next\nnext prose\n\n### Moving\nmoving\n\n### Existing\nexisting",
    );
    expect(rangeText(moved, getSectionRange(moved, moved.indexOf("next prose")))).toStartWith(
      "## Next\nnext prose",
    );
    expect(rangeText(moved, getSectionRange(moved, moved.indexOf("### Moving")))).toBe(
      "### Moving\nmoving\n\n",
    );
    expect(view.state.doc.lineAt(view.state.selection.main.head).text).toBe("### Moving");
    expect(documentChanges).toBe(1);
  });

  test("a subsection moves down to the end of a destination with no subheading", () => {
    const text = "## First\nintro\n### Moving\nmoving\n## Next\nnext prose\n## Following\nlater";
    const view = focusedEditor(text, "### Moving");

    pressMovementKey(view, "down", true);
    const moved = view.state.doc.toString();
    expect(moved).toBe(
      "## First\nintro\n## Next\nnext prose\n### Moving\nmoving\n## Following\nlater",
    );
    expect(rangeText(moved, getSectionRange(moved, moved.indexOf("### Moving")))).toBe(
      "### Moving\nmoving\n",
    );
  });

  test("a subsection moved down into final destination prose adds no trailing newline", () => {
    const text = "## First\nintro\n### Moving\nmoving\n\n## Next\nnext";
    const view = focusedEditor(text, "### Moving");

    pressMovementKey(view, "down", true);
    expect(view.state.doc.toString()).toBe(
      "## First\nintro\n## Next\nnext\n### Moving\nmoving",
    );
  });

  test("a subsection moved down before a following section keeps its separator there", () => {
    const text = "## First\nintro\n### Moving\nmoving\n\n## Next\nnext\n## Following\nlater";
    const view = focusedEditor(text, "### Moving");

    pressMovementKey(view, "down", true);
    expect(view.state.doc.toString()).toBe(
      "## First\nintro\n## Next\nnext\n### Moving\nmoving\n\n## Following\nlater",
    );
  });

  test("a subsection moves up into the previous parent and keeps its heading level", () => {
    const text = "## Previous\nprevious\n\n## Current\nintro\n### Moving\nmoving";
    const view = focusedEditor(text, "### Moving");

    pressMovementKey(view, "up", true);
    expect(view.state.doc.toString()).toBe(
      "## Previous\nprevious\n\n### Moving\nmoving\n## Current\nintro",
    );
    expect(view.state.doc.lineAt(view.state.selection.main.head).text).toBe("### Moving");
  });

  test("crossing subsection moves round-trip byte-identically in both orders", () => {
    const downFirst = "## First\nintro\n\n### Moving\nmoving\n\n## Next\nnext prose\n\n### Existing\nexisting";
    const downView = focusedEditor(downFirst, "### Moving");
    pressMovementKey(downView, "down", true);
    pressMovementKey(downView, "up", true);
    expect(downView.state.doc.toString()).toBe(downFirst);

    const upFirst = "## Previous\nprevious\n\n## Current\nintro\n\n### Moving\nmoving\n\n### Existing\nexisting";
    const upView = focusedEditor(upFirst, "### Moving");
    pressMovementKey(upView, "up", true);
    pressMovementKey(upView, "down", true);
    expect(upView.state.doc.toString()).toBe(upFirst);
  });

  for (const trailingNewline of [false, true]) {
    const ending = trailingNewline ? "with exactly one trailing newline" : "with no trailing newline";

    test(`a subsection moved down then up round-trips ${ending}`, () => {
      const text = `## First\nintro\n### Moving\nmoving\n\n## Next\nnext${trailingNewline ? "\n" : ""}`;
      const view = focusedEditor(text, "### Moving");

      pressMovementKey(view, "down", true);
      pressMovementKey(view, "up", true);
      expect(view.state.doc.toString()).toBe(text);
    });

    test(`a subsection moved up then down round-trips ${ending}`, () => {
      const text = `## Previous\nprevious\n\n## Current\nintro\n### Moving\nmoving${trailingNewline ? "\n" : ""}`;
      const view = focusedEditor(text, "### Moving");

      pressMovementKey(view, "up", true);
      pressMovementKey(view, "down", true);
      expect(view.state.doc.toString()).toBe(text);
    });
  }

  test("empty destinations and destinations whose first child has no preceding prose use the heading boundary", () => {
    const emptyText = "## First\n### Moving\nmoving\n## Empty\n## Following\nlater";
    const empty = focusedEditor(emptyText, "### Moving");
    pressMovementKey(empty, "down", true);
    expect(empty.state.doc.toString()).toBe(
      "## First\n## Empty\n### Moving\nmoving\n## Following\nlater",
    );

    const childFirstText = "## First\n### Moving\nmoving\n## Next\n### Existing\nexisting";
    const childFirst = focusedEditor(childFirstText, "### Moving");
    pressMovementKey(childFirst, "down", true);
    expect(childFirst.state.doc.toString()).toBe(
      "## First\n## Next\n### Moving\nmoving\n### Existing\nexisting",
    );
  });

  test("sections at document edges are consumed no-ops", () => {
    const text = "# First\nfirst\n# Last\nlast";
    const first = focusedEditor(text, "# First");
    pressMovementKey(first, "up", true);
    expect(first.state.doc.toString()).toBe(text);

    const last = focusedEditor(text, "# Last");
    pressMovementKey(last, "down", true);
    expect(last.state.doc.toString()).toBe(text);
  });

  test("a moved section carries all of its subsections", () => {
    const text = "# One\nbody\n## Child\nchild\n### Grandchild\ngrandchild\n# Two\nlast";
    const view = focusedEditor(text, "# One");

    pressMovementKey(view, "down", true);
    expect(view.state.doc.toString()).toBe(
      "# Two\nlast\n# One\nbody\n## Child\nchild\n### Grandchild\ngrandchild",
    );
  });

  test("shifted list movement still takes descendants", () => {
    const text = "- parent\n- moving\n  - child\n- last";
    const view = focusedEditor(text, "moving");

    pressMovementKey(view, "down", true);
    expect(view.state.doc.toString()).toBe("- parent\n- last\n- moving\n  - child");
  });

  test("a list subtree crosses down after destination prose without absorbing its sibling subtree", () => {
    const text = [
      "- first",
      "  - moving",
      "    - own child",
      "- next",
      "  destination prose",
      "  - existing child",
      "    - existing grandchild",
      "- following",
    ].join("\n");
    const view = focusedEditor(text, "moving");

    pressMovementKey(view, "down", true);
    const moved = view.state.doc.toString();
    expect(moved).toBe([
      "- first",
      "- next",
      "  destination prose",
      "  - moving",
      "    - own child",
      "  - existing child",
      "    - existing grandchild",
      "- following",
    ].join("\n"));
    expect(rangeText(moved, getNodeRange(moved, moved.indexOf("moving")))).toBe(
      "  - moving\n    - own child\n",
    );
    expect(rangeText(moved, getNodeRange(moved, moved.indexOf("existing child")))).toBe(
      "  - existing child\n    - existing grandchild\n",
    );

    pressMovementKey(view, "up", true);
    expect(view.state.doc.toString()).toBe(text);
  });

  test("a list subtree moved down into final destination prose adds no trailing newline", () => {
    const text = [
      "- first",
      "  - moving",
      "    - own child",
      "- next",
      "  destination prose",
    ].join("\n");
    const view = focusedEditor(text, "moving");

    pressMovementKey(view, "down", true);
    expect(view.state.doc.toString()).toBe([
      "- first",
      "- next",
      "  destination prose",
      "  - moving",
      "    - own child",
    ].join("\n"));
  });

  for (const trailingNewline of [false, true]) {
    const ending = trailingNewline ? "with exactly one trailing newline" : "with no trailing newline";

    test(`a list subtree moved down then up round-trips ${ending}`, () => {
      const text = [
        "- first",
        "  - moving",
        "    - own child",
        "- next",
        "  destination prose",
      ].join("\n") + (trailingNewline ? "\n" : "");
      const view = focusedEditor(text, "moving");

      pressMovementKey(view, "down", true);
      pressMovementKey(view, "up", true);
      expect(view.state.doc.toString()).toBe(text);
    });

    test(`a list subtree moved up then down round-trips ${ending}`, () => {
      const text = [
        "- previous",
        "  previous prose",
        "- current",
        "  current prose",
        "  - moving",
        "    - own child",
      ].join("\n") + (trailingNewline ? "\n" : "");
      const view = focusedEditor(text, "moving");

      pressMovementKey(view, "up", true);
      pressMovementKey(view, "down", true);
      expect(view.state.doc.toString()).toBe(text);
    });
  }

  test("unshifted paragraph movement still crosses a heading", () => {
    const text = "# One\nfirst paragraph\n\n# Two\nsecond paragraph";
    const view = focusedEditor(text, "first paragraph");

    pressMovementKey(view, "down", false);
    expect(view.state.doc.toString()).toBe(
      "# One\n# Two\nfirst paragraph\n\nsecond paragraph",
    );
  });

  test("front matter and fenced hashes never become movement boundaries", () => {
    const text = "---\ntitle: kept\n---\n# One\nbody\n```md\n# fenced\n```\n# Two\nlast";
    const metadata = focusedEditor(text, "title");
    pressMovementKey(metadata, "down", true);
    expect(metadata.state.doc.toString()).toBe(text);

    const section = focusedEditor(text, "body");
    pressMovementKey(section, "down", true);
    expect(section.state.doc.toString()).toBe(
      "---\ntitle: kept\n---\n# Two\nlast\n# One\nbody\n```md\n# fenced\n```",
    );
  });

  test("a setext heading remains one two-line block", () => {
    const text = "One\n===\nbody\n\nTwo\n===\nlast";
    const view = focusedEditor(text, "One");

    pressMovementKey(view, "down", true);
    expect(view.state.doc.toString()).toBe("Two\n===\nlast\n\nOne\n===\nbody");
  });
});
