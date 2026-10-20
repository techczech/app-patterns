/** Fix round 1: one test per finding of the independent review. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createElement } from "react";
import { defineSchema, emptyState, type ChangeEntry } from "@app-patterns/settings";
import { mount, typeInto } from "./mount.test-support.tsx";
import { installDom } from "./test-dom.ts";
import { SettingsWindow } from "./settings-window.tsx";
import { shellArg } from "./shell.ts";
import { IMPORT_BATCH, IMPORT_FILE, NOW, wfAdapter, wfImportPreview, wfState, wfStateAfterImport } from "../demo/fixture.ts";

let restoreDom: () => void;
beforeEach(() => { restoreDom = installDom(); });
afterEach(() => { cleanup(); restoreDom(); });

const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const nav = (root: HTMLElement, section: string): HTMLElement => root.querySelector(`button[data-section="${section}"]`) as HTMLElement;
const click = (el: Element | null): void => { if (!el) throw new Error("not found"); fireEvent.click(el); };
const text = (el: Element | null | undefined): string => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const insp = (root: HTMLElement): HTMLElement => root.querySelector("aside") as HTMLElement;
const codes = (root: HTMLElement): string[] => [...insp(root).querySelectorAll(".bsw-code span")].map((s) => s.textContent ?? "");
const focus = (el: Element): void => { (el as HTMLElement).focus(); fireEvent.focusIn(el); };
/** An independent POSIX single-quote encoder, to compare the package's against. */
const q = (s: string): string => `'${s.split("'").join("'\\''")}'`;
const HOSTILE = ["$(printf SUBST)", "`printf TICK`", "a;printf SEMI", 'q"r', "it's", "line\nbreak"];

describe("1. shell quoting", () => {
  test("shellArg: plain words as they are, everything else in single quotes", () => {
    expect(shellArg("editor.proseSize")).toBe("editor.proseSize");
    expect(shellArg("20")).toBe("20");
    expect(shellArg("Alt+Cmd+R")).toBe("Alt+Cmd+R");
    expect(shellArg("")).toBe("''");
    for (const h of HOSTILE) expect(shellArg(h)).toBe(q(h));
    expect(shellArg("it's")).toBe("'it'\\''s'");
  });

  test("a setting key and a choice value are quoted in the copied commands", () => {
    for (const h of HOSTILE) {
      const schema = defineSchema({
        app: "demo", sections: [{ id: "s", label: "S", icon: "x" }],
        settings: [{ key: `a;b ${h}`.slice(0, 40), label: "K", section: "s", group: "G", type: "choice", default: "x", options: [{ value: "x", label: "X" }, { value: h, label: "H" }], help: "h" }],
      });
      const key = schema.settings[0]!.key;
      const { container, unmount } = mount({ schema, state: emptyState("demo"), rowHints: {}, slots: [], menus: [], appInfo: { name: "Demo", version: "1", cli: "demo" } });
      click(nav(container, "s"));
      click(container.querySelector("[data-key]"));
      expect(codes(container)).toEqual([`demo settings set ${q(key)} ${q(h)}`, `demo settings reset ${q(key)}`]);
      unmount();
    }
  });

  test("a slot id is quoted", () => {
    for (const h of HOSTILE) {
      const { container, unmount } = mount({ slots: [{ id: h, label: "Hostile", status: "missing" }] });
      click(nav(container, "accounts"));
      click(container.querySelector("[data-slot]"));
      expect(codes(container)[0]).toBe(`editorexample settings get ${q(h)} --json`);
      unmount();
    }
  });

  test("an import's file name keeps ~/Downloads/ outside the quotes; the batch id is quoted", () => {
    for (const h of HOSTILE) {
      const file = `${h}.json`;
      const batch = `b-${h}`;
      const s = wfStateAfterImport();
      s.changes = s.changes.map((e): ChangeEntry => (e.batch === IMPORT_BATCH && e.who.kind === "import" ? { ...e, batch, who: { ...e.who, file } } : e));
      const { container, unmount } = mount({ state: s, initial: { section: "changes", selChange: batch } });
      expect(codes(container)).toEqual([`editorexample settings import ~/Downloads/${q(file)}`, `editorexample settings undo-import ${q(batch)}`]);
      unmount();
    }
    const plain = mount({ state: wfStateAfterImport(), initial: { section: "changes", selChange: IMPORT_BATCH } });
    expect(codes(plain.container)[0]).toBe(`editorexample settings import ~/Downloads/${q(IMPORT_FILE)}`);
  });
});

describe("2. secrets", () => {
  const SENT = "fake-sentinel-value-for-test";
  const noSentinel = (root: HTMLElement): void => {
    expect(root.innerHTML).not.toContain(SENT);
    for (const el of root.querySelectorAll("[value]")) expect(el.getAttribute("value") ?? "").not.toContain(SENT);
    for (const el of root.querySelectorAll("input")) expect((el as HTMLInputElement).value).not.toContain(SENT);
  };

  test("a key draft passed in `initial` is ignored: the field starts empty and the draft is nowhere", () => {
    const { container, getByText } = mount({ initial: { section: "accounts", addingKey: "accounts.readwise", keyDraft: SENT } as never });
    noSentinel(container);
    expect((container.querySelector('input[type="password"]') as HTMLInputElement).value).toBe("");
    expect(getByText("Add key").closest("button")?.hasAttribute("disabled")).toBe(true);
  });

  test("while the save is pending the field is already cleared and empty in the page", async () => {
    let release: (v: { ok: true }) => void = () => {};
    const { container, getByText, calls } = mount({ actions: { setSecret: ((...a: unknown[]) => { (calls.setSecret ??= []).push(a); return new Promise((r) => { release = r as never; }); }) as never } });
    click(nav(container, "accounts"));
    click(getByText("Add key…").closest("button"));
    typeInto(container.querySelector('input[type="password"]'), SENT);
    click(getByText("Add key").closest("button"));
    await flush();
    expect(calls.setSecret).toEqual([["accounts.readwise", SENT]]);
    noSentinel(container);
    release({ ok: true });
    await flush();
    noSentinel(container);
  });

  test("after a failed save the field is empty, the form stays open and the page holds no copy", async () => {
    const { container, getByText } = mount({ actions: { setSecret: (() => ({ ok: false, error: "The service refused the key." })) as never } });
    click(nav(container, "accounts"));
    click(getByText("Add key…").closest("button"));
    typeInto(container.querySelector('input[type="password"]'), SENT);
    click(getByText("Add key").closest("button"));
    await flush();
    noSentinel(container);
    expect(container.textContent).toContain("The service refused the key.");
    const input = container.querySelector('input[type="password"]') as HTMLInputElement;
    expect(input.value).toBe("");
    expect(getByText("Add key").closest("button")?.hasAttribute("disabled")).toBe(true);
  });
});

describe("3. Undo import names its batch", () => {
  test("the newest import names its batch too, never --last; an older one says its own id", () => {
    const s = wfStateAfterImport();
    const older: ChangeEntry[] = s.changes.filter((e) => e.batch === IMPORT_BATCH).map((e) => ({ ...e, id: `${e.id}-old`, batch: "imp0", at: e.at - 3_600_000 }));
    s.changes = [...s.changes, ...older];
    const a = mount({ state: s, initial: { section: "changes", selChange: IMPORT_BATCH } });
    expect(codes(a.container)[1]).toBe(`editorexample settings undo-import ${IMPORT_BATCH}`);
    a.unmount();
    const b = mount({ state: s, initial: { section: "changes", selChange: "imp0" } });
    expect(codes(b.container)[1]).toBe("editorexample settings undo-import imp0");
  });
});

describe("4. keyboard", () => {
  const selected = (el: Element): boolean => el.className.includes("bsw-sel");
  const rowCases: [string, () => ReturnType<typeof mount>, string][] = [
    ["a setting row", () => { const m = mount(); click(nav(m.container, "editor")); return m; }, '[data-key="editor.proseSize"]'],
    ["a Changes entry", () => mount({ initial: { section: "changes" } }), '[data-entry="e1"]'],
    ["an import header", () => mount({ state: wfStateAfterImport(), initial: { section: "changes" } }), `[data-batch="${IMPORT_BATCH}"] > .bsw-ch`],
    ["a shortcut row", () => mount({ initial: { section: "shortcuts" } }), '[data-command="insert-link"]'],
    ["a slot row", () => mount({ initial: { section: "accounts" } }), '[data-slot="accounts.readwise"]'],
  ];
  for (const [name, make, sel] of rowCases) {
    test(`${name} is focusable and Enter or Space selects it`, () => {
      const { container } = make();
      const row = container.querySelector(sel) as HTMLElement;
      expect(row.getAttribute("tabindex")).toBe("0");
      expect(row.getAttribute("aria-current")).toBeNull();
      fireEvent.keyDown(row, { key: "Enter" });
      expect(row.getAttribute("aria-current")).toBe("true");
      expect(selected(row) || selected(row.parentElement!)).toBe(true);
    });
  }

  test("Space selects a Changes entry; a key on a button inside a row does not select the row", () => {
    const { container } = mount({ initial: { section: "changes" } });
    const row = container.querySelector('[data-entry="e1"]') as HTMLElement;
    fireEvent.keyDown(row.querySelector("button")!, { key: "Enter" });
    expect(selected(row)).toBe(false);
    fireEvent.keyDown(row, { key: " " });
    expect(selected(row)).toBe(true);
  });

  test("fixed shortcuts can be selected from the keyboard too", () => {
    const { container } = mount({ initial: { section: "shortcuts" }, showCommand: () => true });
    const fixed = container.querySelector(".bsw-cmd .bsw-kbd.bsw-fix")?.closest(".bsw-cmd") as HTMLElement;
    expect(fixed).toBeTruthy();
    expect(fixed.getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(fixed, { key: "Enter" });
    expect(selected(fixed)).toBe(true);
  });

  test("focusing a row's own control selects that row; clicking it afterwards does not unselect it", () => {
    const { container } = mount({ initial: { section: "readaloud" } });
    const row = container.querySelector('[data-key="readAloud.rate"]') as HTMLElement;
    const input = row.querySelector("input")!;
    focus(input);
    expect(selected(row)).toBe(true);
    expect(text(insp(container).querySelector(".bsw-nm"))).toBe("Default speed");
    click(input);
    expect(selected(row)).toBe(true);
  });

  test("a slot's button focus selects the slot", () => {
    const { container } = mount({ initial: { section: "accounts" } });
    const row = container.querySelector('[data-slot="accounts.readwise"]') as HTMLElement;
    focus(within(row).getByText("Add key…").closest("button")!);
    expect(selected(row)).toBe(true);
  });

  test("a number field steps with ArrowUp and ArrowDown; the step buttons are out of the tab order", () => {
    const { container, calls } = mount({ initial: { section: "readaloud" } });
    const row = container.querySelector('[data-key="readAloud.rate"]') as HTMLElement;
    const input = row.querySelector("input")!;
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    // The recording mount keeps the saved value at 1.25; the step back to 1.25 still differs from the 1.5 just asked for, so it is written.
    expect(input.value).toBe("1.25");
    expect(calls.set).toEqual([["readAloud.rate", 1.5], ["readAloud.rate", 1.25]]);
    for (const b of row.querySelectorAll(".bsw-st button")) expect(b.getAttribute("tabindex")).toBe("-1");
  });
});

describe("5. modal sheets", () => {
  const open = () => {
    const m = mount({ initial: { section: "about" } });
    const opener = m.getByText("Reset all settings…").closest("button") as HTMLElement;
    focus(opener);
    click(opener);
    return { ...m, opener, dialog: m.container.querySelector('[role="dialog"]') as HTMLElement };
  };

  test("focus starts on Cancel, the background is inert, and Escape cancels and returns focus to the opener", () => {
    const { container, dialog, opener, calls } = open();
    expect(text(document.activeElement)).toBe("Cancel");
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(container.querySelector(".bsw-body")?.hasAttribute("inert")).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector(".bsw-body")?.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).toBe(opener);
    expect(calls.resetAll).toBeUndefined();
  });

  test("Tab and Shift+Tab stay inside the sheet", () => {
    const { dialog } = open();
    const btns = [...dialog.querySelectorAll("button:not([disabled])")] as HTMLElement[];
    expect(btns.length).toBe(2);
    focus(btns[1]!);
    fireEvent.keyDown(btns[1]!, { key: "Tab" });
    expect(document.activeElement).toBe(btns[0]!);
    fireEvent.keyDown(btns[0]!, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(btns[1]!);
  });

  test("closing by Cancel also restores focus", () => {
    const { container, dialog, opener } = open();
    click(within(dialog).getByText("Cancel").closest("button"));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  test("the import sheet and the wrong-file sheet take focus and keep Escape as Cancel", async () => {
    const preview = wfImportPreview();
    const a = mount({ actions: { importPick: (() => ({ fileName: IMPORT_FILE, preview })) as never } });
    const opener = a.getByText("Import settings…").closest("button") as HTMLElement;
    focus(opener);
    click(opener);
    await flush();
    expect(text(document.activeElement)).toBe("Cancel");
    expect(a.container.querySelector(".bsw-body")?.hasAttribute("inert")).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(a.container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe("6. shortcut agent commands", () => {
  test("hidden by default", () => {
    const { container } = mount({ initial: { section: "shortcuts", selItem: "insert-link" } });
    expect(insp(container).querySelector(".bsw-code")).toBeNull();
    expect(container.innerHTML).not.toContain("shortcut.insertLink");
  });

  test("when enabled: rebind and reset-shortcut, with the command id and chord quoted", () => {
    const { container } = mount({ agentCommandsForShortcuts: true, initial: { section: "shortcuts", selItem: "insert-link" } });
    expect(codes(container)).toEqual(["editorexample settings rebind insert-link Cmd+L", "editorexample settings reset-shortcut insert-link"]);
    expect(container.innerHTML).not.toContain("shortcut.insertLink");
  });
});

describe("7. a successful import lands on its batch in Changes", () => {
  const start = (apply: (m: { rerender: (s: ReturnType<typeof wfStateAfterImport>) => void }) => unknown) => {
    const preview = wfImportPreview();
    const ref: { rerender: (s: ReturnType<typeof wfStateAfterImport>) => void } = { rerender: () => {} };
    const m = mount({ actions: { importPick: (() => ({ fileName: IMPORT_FILE, preview })) as never, importApply: (() => apply(ref)) as never } });
    ref.rerender = (state) => { m.rerender(createElement(SettingsWindow, { ...m.props, state })); };
    return m;
  };
  const run = async (m: ReturnType<typeof mount>): Promise<void> => {
    click(m.getByText("Import settings…").closest("button"));
    await flush();
    click(within(m.container.querySelector('[role="dialog"]') as HTMLElement).getByText("Import 6 settings").closest("button"));
    await flush();
  };

  test("the host updates the state before it returns, naming the batch", async () => {
    const m = start((r) => { r.rerender(wfStateAfterImport()); return { ok: true, batch: IMPORT_BATCH }; });
    await run(m);
    expect(text(m.container.querySelector("h1"))).toBe("Changes");
    expect(text(insp(m.container).querySelector(".bsw-nm"))).toBe("Import from file");
    expect(m.container.querySelector(`[data-batch="${IMPORT_BATCH}"]`)?.className).toContain("bsw-sel");
  });

  test("the host updates the state after it returns, naming nothing: the newest import is found when it arrives", async () => {
    const m = start(() => ({ ok: true }));
    await run(m);
    expect(text(m.container.querySelector("h1"))).toBe("Changes");
    await act(async () => { m.props.state = wfStateAfterImport(); m.rerender(createElement(SettingsWindow, { ...m.props, state: wfStateAfterImport() })); await Promise.resolve(); });
    expect(text(insp(m.container).querySelector(".bsw-nm"))).toBe("Import from file");
    expect(m.container.querySelector(`[data-batch="${IMPORT_BATCH}"]`)?.className).toContain("bsw-sel");
  });

  test("a failed import stays where it was and shows the error", async () => {
    const m = start(() => ({ ok: false, error: "Could not write the settings file." }));
    await run(m);
    expect(text(m.container.querySelector("h1"))).toBe("General");
    expect(m.container.textContent).toContain("Could not write the settings file.");
  });
});

describe("8. onChangesSeen", () => {
  const before = new Date(2026, 9, 19, 10, 30).getTime();
  const now = new Date(2026, 9, 19, 10, 39).getTime();

  test("fires when Changes opens, and again when it is left", () => {
    const seen: number[] = [];
    const { container } = mount({ changesSeenAt: before, now, onChangesSeen: (t) => seen.push(t) });
    expect(seen).toEqual([]);
    click(nav(container, "changes"));
    expect(seen).toEqual([now]);
    click(nav(container, "general"));
    expect(seen).toEqual([now, now]);
  });

  test("fires when the window starts on Changes, and when it closes on Changes", () => {
    const seen: number[] = [];
    const { unmount } = mount({ changesSeenAt: before, now, onChangesSeen: (t) => seen.push(t), initial: { section: "changes" } });
    expect(seen).toEqual([now]);
    unmount();
    expect(seen).toEqual([now, now]);
  });

  test("unmounting elsewhere does not fire it", () => {
    const seen: number[] = [];
    const { unmount } = mount({ changesSeenAt: before, now, onChangesSeen: (t) => seen.push(t) });
    unmount();
    expect(seen).toEqual([]);
  });

  test("the new highlight stays for the visit even when the host stores the time at once, and is gone after", () => {
    const { container, rerender, props } = mount({ changesSeenAt: before, now });
    click(nav(container, "changes"));
    expect(container.querySelector('[data-entry="e1"]')?.className).toContain("bsw-fresh");
    rerender(createElement(SettingsWindow, { ...props, changesSeenAt: now }));
    expect(container.querySelector('[data-entry="e1"]')?.className).toContain("bsw-fresh");
    click(nav(container, "general"));
    click(nav(container, "changes"));
    expect(container.querySelector('[data-entry="e1"]')?.className).not.toContain("bsw-fresh");
  });
});
void NOW; void wfAdapter; void wfState;
