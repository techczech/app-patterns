import { SettingsUpdatesCard } from "./updates.tsx";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { changedFromDefault, changeCounts, searchSettings, newSince, applyImport, type ImportPreview } from "@app-patterns/settings";
import { createElement } from "react";
import { SettingsWindow } from "./settings-window.tsx";
import { mount, rowKeys, typeInto } from "./mount.test-support.tsx";
import { installDom } from "./test-dom.ts";
import {
  IMPORT_BATCH, IMPORT_FILE, NOW, twState, wfAdapter, wfImportFile, wfImportPreview, wfSchema, wfState, wfStateAfterImport,
} from "../demo/fixture.ts";
import { previewImport, exportFile } from "@app-patterns/settings";
import { twRegistry, twSchema } from "../demo/fixture.ts";

let restoreDom: () => void;
beforeEach(() => { restoreDom = installDom(); });
afterEach(() => { cleanup(); restoreDom(); });

const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
const nav = (root: HTMLElement, section: string): HTMLElement => root.querySelector(`button[data-section="${section}"]`) as HTMLElement;
const click = (el: Element | null): void => { if (!el) throw new Error("not found"); fireEvent.click(el); };
const text = (el: Element | null | undefined): string => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const insp = (root: HTMLElement): HTMLElement => root.querySelector("aside") as HTMLElement;

describe("every page renders", () => {
  test("each settings section shows exactly its schema's rows, grouped in cards", () => {
    const { container } = mount();
    const sections = wfSchema.sections.filter((s) => !["shortcuts", "accounts", "changes", "about"].includes(s.id));
    expect(sections.length).toBe(10);
    for (const s of sections) {
      click(nav(container, s.id));
      expect(rowKeys(container)).toEqual(wfSchema.settings.filter((d) => d.section === s.id).map((d) => d.key));
      expect(text(container.querySelector("h1"))).toBe(s.label);
      const groups = new Set(wfSchema.settings.filter((d) => d.section === s.id).map((d) => d.group));
      expect(container.querySelectorAll(".bsw-pscroll > .bsw-card > .bsw-ch").length).toBeGreaterThanOrEqual(groups.size);
    }
  });

  test("the sidebar lists shared sections under All apps, own sections under the app name, Changes and About at the foot", () => {
    const { container } = mount();
    const groups = [...container.querySelectorAll(".bsw-grp")].map((g) => text(g));
    expect(groups).toEqual(["All apps", "Example Editor"]);
    const ids = [...container.querySelectorAll("button[data-section]")].map((b) => b.getAttribute("data-section"));
    expect(ids).toEqual(["general", "appearance", "shortcuts", "accounts", "assistant", "editor", "readingroom", "readaloud", "sounds", "library", "diary", "saving", "changes", "about"]);
    expect(container.querySelector(".bsw-sidefoot")?.querySelectorAll("button").length).toBe(2);
  });

  test("General ends with the Settings file card and its two buttons", () => {
    const { container, getByText } = mount();
    const cards = container.querySelectorAll(".bsw-pscroll > .bsw-card");
    expect(text(cards[cards.length - 1]?.querySelector(".bsw-ch"))).toBe("Settings file");
    expect(getByText("Export settings…")).toBeTruthy();
    expect(getByText("Import settings…")).toBeTruthy();
  });

  test("a shared section with no settings and no custom page is left out of the sidebar, and a link to it opens General", () => {
    const tw = { schema: twSchema, state: twState(), registry: twRegistry, appInfo: { name: "Example Recorder", version: "0.41.0" }, slots: [], rowHints: {} };
    expect(twSchema.settings.some((d) => d.section === "appearance")).toBe(false);
    const { container, unmount } = mount({ ...tw, initial: { section: "appearance" } });
    const ids = [...container.querySelectorAll("button[data-section]")].map((b) => b.getAttribute("data-section"));
    expect(ids).not.toContain("appearance");
    expect(ids).toEqual(expect.arrayContaining(["general", "shortcuts", "accounts", "changes", "about"]));
    expect(text(container.querySelector("h1"))).toBe("General");
    unmount();
    // A custom page with that id keeps it.
    const withPage = mount({ ...tw, customPages: [{ id: "appearance", label: "Appearance", icon: "palette", placement: "all", render: () => <p>Themes</p> }] });
    expect(nav(withPage.container, "appearance")).toBeTruthy();
  });

  test("a custom page appears in the sidebar and renders its own content", () => {
    const { container } = mount({ customPages: [{ id: "labs", label: "Labs", icon: "flask-conical", render: () => <p>Experimental things</p> }] });
    click(nav(container, "labs"));
    expect(text(container.querySelector("h1"))).toBe("Labs");
    expect(container.textContent).toContain("Experimental things");
  });

  test("row controls: toggle, popup choice, segmented, text, number, path, chord, secret", () => {
    const { container, calls } = mount();
    click(nav(container, "readaloud"));
    const row = (k: string) => container.querySelector(`[data-key="${k}"]`) as HTMLElement;
    expect(row("readAloud.highlight").querySelector('[role="switch"]')?.getAttribute("aria-checked")).toBe("false");
    expect(row("readAloud.voiceURI").querySelector("select")).toBeTruthy();
    expect(row("readAloud.highlightStrength").querySelector('[role="radiogroup"]')).toBeTruthy();
    expect((row("readAloud.skipPrefix").querySelector("input") as HTMLInputElement).value).toBe("%%");
    expect((row("readAloud.rate").querySelector("input") as HTMLInputElement).value).toBe("1.25");
    expect(text(row("readAloud.rate").querySelector(".bsw-u"))).toBe("×");
    expect(text(row("readAloud.cacheFolder").querySelector(".bsw-path"))).toBe("~/Library/Caches/Example Editor/audio");
    expect(text(row("shortcut.readAloud").querySelector(".bsw-kbd"))).toBe("⌥⌘R");
    expect(text(row("accounts.speech").querySelector(".bsw-secv"))).toContain("Saved in Keychain");
    // each writes through `set` with its own type of value
    click(row("readAloud.highlight").querySelector('[role="switch"]'));
    fireEvent.change(row("readAloud.voiceURI").querySelector("select")!, { target: { value: "0" } });
    const skip = row("readAloud.skipPrefix").querySelector("input")!;
    typeInto(skip, "//");
    fireEvent.blur(skip);
    click(row("readAloud.rate").querySelector('button[aria-label^="Increase"]'));
    expect(calls.set).toEqual([["readAloud.highlight", true], ["readAloud.voiceURI", "system"], ["readAloud.skipPrefix", "//"], ["readAloud.rate", 1.5]]);
  });

  test("a disabled row says why and cannot be changed", () => {
    const { container } = mount();
    click(nav(container, "readaloud"));
    const row = container.querySelector('[data-key="readAloud.highlightStrength"]') as HTMLElement;
    expect(row.className).toContain("bsw-dis");
    expect(text(row)).toContain("Turn on the highlight to choose a strength.");
    expect(row.querySelector(".bsw-ctl")?.hasAttribute("inert")).toBe(true);
  });

  test("a path that is not on this Mac shows the missing state, and Choose… asks the host", async () => {
    const { container, calls } = mount({
      rowHints: { "diary.folder": { missing: true } },
      actions: { choosePath: ((...a: unknown[]) => { (calls.choosePath ??= []).push(a); return "/Volumes/Notes"; }) as never },
    });
    click(nav(container, "diary"));
    const row = container.querySelector('[data-key="diary.folder"]') as HTMLElement;
    expect(row.querySelector(".bsw-path")?.className).toContain("bsw-miss");
    expect(text(row)).toContain("This folder is not on this Mac.");
    click(row.querySelector('button[aria-label^="Choose"]'));
    await flush();
    expect(calls.choosePath).toEqual([["diary.folder"]]);
    expect(calls.set).toEqual([["diary.folder", "/Volumes/Notes"]]);
  });

  test("a chord setting is recorded in place", () => {
    const { container, calls } = mount();
    click(nav(container, "readaloud"));
    const row = container.querySelector('[data-key="shortcut.readAloud"]') as HTMLElement;
    click(row.querySelector(".bsw-kbd"));
    const rec = row.querySelector(".bsw-rec") as HTMLElement;
    expect(rec.textContent).toBe("Press new shortcut…");
    fireEvent.keyDown(rec, { code: "KeyJ", metaKey: true, altKey: true });
    expect(calls.set).toEqual([["shortcut.readAloud", "⌘⌥J"]]);
  });
});

describe("a number that is typed wrong", () => {
  test("shows the reason and the value still in use, and writes nothing", () => {
    const { container, calls } = mount();
    click(nav(container, "readaloud"));
    const row = container.querySelector('[data-key="readAloud.paragraphPause"]') as HTMLElement;
    const input = row.querySelector("input") as HTMLInputElement;
    typeInto(input, "-5");
    fireEvent.blur(input);
    expect(text(row)).toContain("Enter a number from 0 to 2000. Still using 250 ms.");
    expect(row.className).toContain("bsw-err");
    expect(calls.set).toBeUndefined();
    typeInto(input, "300");
    fireEvent.blur(input);
    expect(text(row)).not.toContain("Still using");
    expect(calls.set).toEqual([["readAloud.paragraphPause", 300]]);
  });
});

describe("a number is stepped from what is typed", () => {
  test("ArrowUp steps from the typed value when it is a number: saved 1.25, step 0.25, typed 2 gives 2.25", () => {
    const { container, calls } = mount();
    click(nav(container, "readaloud"));
    const row = container.querySelector('[data-key="readAloud.rate"]') as HTMLElement;
    const input = row.querySelector("input")!;
    typeInto(input, "2");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(calls.set).toEqual([["readAloud.rate", 2.25]]);
  });

  test("stepping to the saved value still shows it: saved 1.25, step 0.25, typed 1, ArrowUp shows 1.25, blur writes nothing, ArrowUp writes 1.5", () => {
    const { container, calls } = mount();
    click(nav(container, "readaloud"));
    const row = container.querySelector('[data-key="readAloud.rate"]') as HTMLElement;
    const input = row.querySelector("input")!;
    typeInto(input, "1");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("1.25");
    fireEvent.blur(input);
    expect(calls.set).toBeUndefined();
    input.focus(); // the field is focused again before the next press, as a person would; the test blur does not move focus
    fireEvent.focusIn(input);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.value).toBe("1.5");
    expect(calls.set).toEqual([["readAloud.rate", 1.5]]);
  });

  test("a step back while an earlier save is still pending is written: saved 1.25, ArrowUp (pending), ArrowDown, both resolve, field ends at 1.25", async () => {
    const writes: unknown[][] = [];
    const settle: Array<() => void> = [];
    const set = (key: string, value: unknown) => {
      writes.push([key, value]);
      return new Promise<{ ok: true }>((resolve) => { settle.push(() => resolve({ ok: true })); });
    };
    const { container } = mount({ actions: { set: set as never } });
    click(nav(container, "readaloud"));
    const row = container.querySelector('[data-key="readAloud.rate"]') as HTMLElement;
    const input = row.querySelector("input")!;
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.value).toBe("1.25");
    await act(async () => { for (const s of settle) s(); await Promise.resolve(); await Promise.resolve(); });
    expect(writes).toEqual([["readAloud.rate", 1.5], ["readAloud.rate", 1.25]]);
    expect(input.value).toBe("1.25");
  });

  test("a typed value equal to the saved one is written while an up-step is pending: saved 1.25, ArrowUp (pending 1.5), type 1.25, blur, resolve gives writes 1.5 then 1.25", async () => {
    const writes: unknown[][] = [];
    const settle: Array<() => void> = [];
    const set = (key: string, value: unknown) => {
      writes.push([key, value]);
      return new Promise<{ ok: true }>((resolve) => { settle.push(() => resolve({ ok: true })); });
    };
    const { container } = mount({ actions: { set: set as never } });
    click(nav(container, "readaloud"));
    const row = container.querySelector('[data-key="readAloud.rate"]') as HTMLElement;
    const input = row.querySelector("input")!;
    fireEvent.keyDown(input, { key: "ArrowUp" });
    typeInto(input, "1.25");
    fireEvent.blur(input);
    expect(input.value).toBe("1.25");
    await act(async () => { for (const s of settle) s(); await Promise.resolve(); await Promise.resolve(); });
    expect(writes).toEqual([["readAloud.rate", 1.5], ["readAloud.rate", 1.25]]);
    expect(input.value).toBe("1.25");
  });

  test("a saved value that arrives from outside is the new baseline: request 1.5 pending, host saves 1.5 then 2, user types 1.5 and blurs, writes 1.5 again", async () => {
    const writes: unknown[][] = [];
    const settle: Array<() => void> = [];
    const set = (key: string, value: unknown) => {
      writes.push([key, value]);
      return new Promise<unknown>((resolve) => { settle.push(() => resolve({ ok: true })); });
    };
    const { container, rerender, props } = mount({ actions: { set: set as never } });
    const withRate = (rate: number) => createElement(SettingsWindow, { ...props, state: { ...props.state, settings: { ...props.state.settings, "readAloud.rate": rate } } });
    click(nav(container, "readaloud"));
    const row = container.querySelector('[data-key="readAloud.rate"]') as HTMLElement;
    const input = row.querySelector("input")!;
    input.focus(); fireEvent.focusIn(input);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(writes).toEqual([["readAloud.rate", 1.5]]);
    rerender(withRate(1.5));
    rerender(withRate(2));
    typeInto(input, "1.5");
    fireEvent.blur(input);
    expect(writes).toEqual([["readAloud.rate", 1.5], ["readAloud.rate", 1.5]]);
    await act(async () => { for (const s of settle) s(); await Promise.resolve(); await Promise.resolve(); });
    rerender(withRate(1.5));
    expect(input.value).toBe("1.5");
  });

  test("a request that fails does not block the next commit: saved 1.25, ArrowUp fails, type 1.5 and blur writes 1.5 again", async () => {
    const writes: unknown[][] = [];
    const settle: Array<() => void> = [];
    const set = (key: string, value: unknown) => {
      writes.push([key, value]);
      return new Promise<unknown>((resolve) => { settle.push(() => resolve({ ok: false, error: "Not saved" })); });
    };
    const { container } = mount({ actions: { set: set as never } });
    click(nav(container, "readaloud"));
    const row = container.querySelector('[data-key="readAloud.rate"]') as HTMLElement;
    const input = row.querySelector("input")!;
    input.focus(); fireEvent.focusIn(input);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    await act(async () => { for (const s of settle) s(); await Promise.resolve(); await Promise.resolve(); });
    typeInto(input, "1.5");
    fireEvent.blur(input);
    expect(writes).toEqual([["readAloud.rate", 1.5], ["readAloud.rate", 1.5]]);
  });

  test("text that is not a number steps from the saved value", () => {
    const { container, calls } = mount();
    click(nav(container, "readaloud"));
    const row = container.querySelector('[data-key="readAloud.rate"]') as HTMLElement;
    const input = row.querySelector("input")!;
    typeInto(input, "fast");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(calls.set).toEqual([["readAloud.rate", 1.5]]);
  });
});

describe("search", () => {
  test("finds settings by label and help in the sidebar's order, counts them per section and marks the words", () => {
    const { container } = mount();
    const q = container.querySelector('input[aria-label="Search settings"]') as HTMLInputElement;
    typeInto(q, "font");
    expect(text(container.querySelector("h1"))).toBe("Results for “font”");
    expect(rowKeys(container)).toEqual(["appearance.uiSize", "editor.proseSize", "editor.leadStyle"]);
    expect(text(container.querySelector(".bsw-phead .bsw-meta"))).toBe("3 settings in 2 sections");
    expect(text(nav(container, "appearance").querySelector(".bsw-cnt"))).toBe("1");
    expect(text(nav(container, "editor").querySelector(".bsw-cnt"))).toBe("2");
    expect(nav(container, "general").className).toContain("bsw-muted");
    expect([...container.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["Font", "Font", "font"]);
  });

  test("agrees with the core's searchSettings", () => {
    const { container } = mount();
    const q = container.querySelector('input[aria-label="Search settings"]') as HTMLInputElement;
    typeInto(q, "speed");
    const expected = searchSettings(wfSchema.settings, wfSchema.sections, "speed").map((h) => h.key);
    expect(expected.length).toBeGreaterThan(0);
    expect(rowKeys(container)).toEqual(expected);
  });

  test("nothing found: Search commands in Shortcuts carries the words over; Clear search goes back", () => {
    const { container, getByText } = mount();
    const q = container.querySelector('input[aria-label="Search settings"]') as HTMLInputElement;
    typeInto(q, "dictionary");
    expect(text(container.querySelector(".bsw-empty h2"))).toBe("No settings match “dictionary”");
    click(getByText("Search commands in Shortcuts").closest("button"));
    expect(text(container.querySelector("h1"))).toBe("Shortcuts");
    expect((container.querySelector('input[aria-label="Search commands"]') as HTMLInputElement).value).toBe("dictionary");
    expect((container.querySelector('input[aria-label="Search settings"]') as HTMLInputElement).value).toBe("");
    typeInto(container.querySelector('input[aria-label="Search settings"]')!, "zzz");
    click(getByText("Clear search").closest("button"));
    expect(text(container.querySelector("h1"))).toBe("Shortcuts");
  });

  test("Go to section leaves the results", () => {
    const { container, getAllByText } = mount();
    typeInto(container.querySelector('input[aria-label="Search settings"]')!, "font");
    click(getAllByText("Go to section")[1]!.closest("a"));
    expect(text(container.querySelector("h1"))).toBe("Editor");
  });
});

describe("reset", () => {
  test("a changed row resets that one setting; a default row has no Reset", () => {
    const { container, calls } = mount();
    click(nav(container, "editor"));
    const row = container.querySelector('[data-key="editor.proseSize"]') as HTMLElement;
    click(within(row).getByText("Reset").closest("button"));
    expect(calls.reset).toEqual([["editor.proseSize"]]);
    expect(within(container.querySelector('[data-key="editor.lineWidth"]') as HTMLElement).queryByText("Reset")).toBeNull();
  });

  test("Reset section… names the count and calls resetSection with the section id", () => {
    const { container, getByText } = mount();
    click(nav(container, "readaloud"));
    expect(text(container.querySelector(".bsw-phead .bsw-meta"))).toBe("2 changed from default");
    expect(changedFromDefault(wfState(), wfSchema, "readaloud").count).toBe(2);
    click(getByText("Reset section…").closest("button"));
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(text(dialog)).toContain("Reset Read aloud?");
    expect(text(dialog)).toContain("2 settings return to their defaults.");
    click(within(dialog).getByText("Reset 2 settings"));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  test("Reset section confirm calls the action", () => {
    const { container, getByText, calls } = mount();
    click(nav(container, "readaloud"));
    click(getByText("Reset section…").closest("button"));
    click(within(container.querySelector('[role="dialog"]') as HTMLElement).getByText("Reset 2 settings").closest("button"));
    expect(calls.resetSection).toEqual([["readaloud"]]);
  });

  test("a section with nothing changed has no Reset section button", () => {
    const { container, queryByText } = mount();
    click(nav(container, "sounds"));
    expect(queryByText("Reset section…")).toBeNull();
  });

  test("Reset all settings… on About counts settings and shortcuts, Cancel does nothing, confirm calls resetAll", () => {
    const { container, getByText, calls } = mount();
    click(nav(container, "about"));
    expect(text(container)).toContain("5 settings and 1 shortcut differ from their defaults.");
    click(getByText("Reset all settings…").closest("button"));
    let dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(text(dialog)).toContain("Reset all settings?");
    expect(text(dialog)).toContain("5 settings and 1 shortcut return to their defaults.");
    click(within(dialog).getByText("Cancel"));
    expect(calls.resetAll).toBeUndefined();
    click(getByText("Reset all settings…").closest("button"));
    dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    click(within(dialog).getByText("Reset 6 settings").closest("button"));
    expect(calls.resetAll).toEqual([[]]);
  });

  test("Esc closes a sheet", () => {
    const { container, getByText } = mount();
    click(nav(container, "about"));
    click(getByText("Reset all settings…").closest("button"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  test("with nothing changed, Reset all is disabled and says so", () => {
    const { container, getByText } = mount({ state: { ...wfState(), settings: {}, keys: {} } });
    click(nav(container, "about"));
    expect((getByText("Reset all settings…").closest("button") as HTMLButtonElement).disabled).toBe(true);
    expect(text(container)).toContain("Every setting and shortcut has its default.");
  });

  test("an action that fails shows its error and leaves the window usable", async () => {
    const { container, getByRole } = mount({ actions: { reset: () => ({ ok: false, error: "It already has its earlier value" }) as never } });
    click(nav(container, "editor"));
    click(within(container.querySelector('[data-key="editor.proseSize"]') as HTMLElement).getByText("Reset").closest("button"));
    await flush();
    expect(text(getByRole("alert"))).toContain("It already has its earlier value");
    click(getByRole("alert").querySelector("button"));
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

describe("the inspector", () => {
  test("nothing selected: recent changes, newest five, with Reset on each and All changes (n)", () => {
    const { container, calls } = mount();
    const a = insp(container);
    expect(text(a.querySelector("h4"))).toBe("Recent changes");
    const items = a.querySelectorAll(".bsw-rci");
    expect(items.length).toBe(5);
    expect(text(items[0])).toContain("Checkpoint on close");
    expect(text(items[0])).toContain("Every close → Off");
    expect(text(items[0])).toContain("Claude Code");
    expect(text(items[0])).toContain("Today 10:38");
    expect(text(items[4])).toContain("Reset");
    expect(text(items[4])).toContain("Thu 15 Oct");
    expect(text(a.querySelector(".bsw-rcfoot"))).toBe("All changes (9)");
    expect(changeCounts(wfState()).all).toBe(9);
    click(within(items[1] as HTMLElement).getByText("Reset").closest("button"));
    expect(calls.resetEntry).toEqual([["e2"]]);
  });

  test("All changes (n) opens Changes", () => {
    const { container, getByText } = mount();
    click(getByText(/All changes/).closest("button"));
    expect(text(container.querySelector("h1"))).toBe("Changes");
  });

  test("a changed setting selected: description, default, current, changed by, history, Reset to the default, agent commands", () => {
    const { container, calls } = mount();
    click(nav(container, "editor"));
    click(container.querySelector('[data-key="editor.proseSize"]'));
    const a = insp(container);
    expect(text(a.querySelector(".bsw-nm"))).toBe("Prose size");
    expect(text(a.querySelector(".bsw-where"))).toBe("Editor › Text");
    expect(text(a)).toContain("Font size of body text in the editor and the Reading Room.");
    const kv = text(a.querySelector(".bsw-kv"));
    expect(kv).toContain("Default16 pt");
    expect(kv).toContain("Current18 pt Changed");
    expect(kv).toContain("Changed byYou");
    expect(text(a.querySelector(".bsw-hist"))).toContain("16 pt → 18 pt");
    expect(text(a.querySelector(".bsw-hist"))).toContain("Today 09:12");
    const codes = [...a.querySelectorAll(".bsw-code span")].map((s) => text(s));
    expect(codes).toEqual(["editorexample settings set editor.proseSize 20", "editorexample settings reset editor.proseSize"]);
    click(within(a).getByText("Reset to 16 pt").closest("button"));
    expect(calls.reset).toEqual([["editor.proseSize"]]);
  });

  test("an unchanged setting: Never changed, and Reset to is disabled", () => {
    const { container } = mount();
    click(nav(container, "editor"));
    click(container.querySelector('[data-key="editor.lineWidth"]'));
    const a = insp(container);
    expect(text(a.querySelector(".bsw-kv"))).toContain("Never changed");
    expect(text(a.querySelector(".bsw-hist"))).toBe("Never changed");
    expect((within(a).getByText("Reset to Medium").closest("button") as HTMLButtonElement).disabled).toBe(true);
  });

  test("a click anywhere on the row outside its control opens the inspector, and a second click keeps it open", () => {
    const { container } = mount();
    click(nav(container, "editor"));
    const row = container.querySelector('[data-key="editor.lineWidth"]') as HTMLElement;
    click(row.querySelector(".bsw-t"));
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(text(insp(container).querySelector("h4"))).toBe("Inspector");
    // The screenshot pass: description first, then the label of the same row.
    const other = container.querySelector('[data-key="editor.proseSize"]') as HTMLElement;
    click(other.querySelector(".bsw-h"));
    expect(other.getAttribute("aria-current")).toBe("true");
    click(other.querySelector(".bsw-t"));
    expect(other.getAttribute("aria-current")).toBe("true");
    expect(text(insp(container).querySelector("h4"))).toBe("Inspector");
  });

  test("clicking empty space in the pane goes back to recent changes", () => {
    const { container } = mount();
    click(nav(container, "editor"));
    click(container.querySelector('[data-key="editor.proseSize"]'));
    expect(text(insp(container).querySelector("h4"))).toBe("Inspector");
    click(container.querySelector('[data-key="editor.proseSize"]'));
    expect(text(insp(container).querySelector("h4"))).toBe("Inspector");
    click(container.querySelector(".bsw-card"));
    expect(text(insp(container).querySelector("h4"))).toBe("Inspector"); // a card's own space is not empty pane space
    click(container.querySelector("#bsw-scroll"));
    expect(text(insp(container).querySelector("h4"))).toBe("Recent changes");
  });

  test("clicking empty space in a search result pane clears the selected setting too", () => {
    const { container } = mount();
    typeInto(container.querySelector('input[aria-label="Search settings"]') as HTMLInputElement, "prose");
    click(container.querySelector('[data-key="editor.proseSize"]'));
    expect(text(insp(container).querySelector("h4"))).toBe("Inspector");
    click(container.querySelector(".bsw-card"));
    expect(text(insp(container).querySelector("h4"))).toBe("Inspector"); // a card's own space is not empty pane space
    click(container.querySelector(".bsw-pscroll"));
    expect(text(insp(container).querySelector("h4"))).toBe("Recent changes");
  });

  test("a secret: agents see whether a key is saved, never its value, and there is no Reset", () => {
    const { container } = mount();
    click(nav(container, "readaloud"));
    click(container.querySelector('[data-key="accounts.speech"]'));
    const a = insp(container);
    expect(text(a)).toContain("Agents can see whether a key is saved, never its value.");
    expect(text(a.querySelector(".bsw-kv"))).toContain("CurrentSaved in Keychain");
    expect(a.querySelector(".bsw-code")).toBeNull();
    expect(within(a).queryByText(/^Reset to/)).toBeNull();
  });

  test("on Changes it shows the selected entry's setting", () => {
    const { container } = mount();
    click(nav(container, "changes"));
    expect(text(insp(container))).toContain("No change selected");
    click(container.querySelector('[data-entry="e4"]'));
    const a = insp(container);
    expect(text(a.querySelector(".bsw-nm"))).toBe("Reading focus");
    expect(text(a.querySelector(".bsw-kv"))).toContain("Example Editor assistant");
  });

  test("on Changes a shortcut entry shows the shortcut's inspector", () => {
    const { container } = mount();
    click(nav(container, "changes"));
    click(container.querySelector('[data-entry="e9"]'));
    const a = insp(container);
    expect(text(a.querySelector(".bsw-nm"))).toBe("Go to heading");
    expect(text(a.querySelector(".bsw-kv"))).toContain("Default⇧⌘G");
    expect(text(a.querySelector(".bsw-kv"))).toContain("Current⇧⌘O");
  });
});

describe("agent changes", () => {
  const seenBefore = new Date(2026, 9, 19, 10, 30).getTime();
  const nowJustAfter = new Date(2026, 9, 19, 10, 39).getTime();

  test("a row changed by an agent since Changes was last opened is highlighted, says who and when, and links to its entry", () => {
    const { container } = mount({ changesSeenAt: seenBefore, now: nowJustAfter });
    expect(text(nav(container, "changes").querySelector(".bsw-cnt"))).toBe("1 new");
    expect(newSince(wfState(), seenBefore)).toBe(1);
    click(nav(container, "saving"));
    const row = container.querySelector('[data-key="snapshots.frequency"]') as HTMLElement;
    expect(row.className).toContain("bsw-agent");
    expect(text(row)).toContain("Changed by Claude Code just now");
    expect(text(row)).toContain("was Every close");
    click(within(row).getByText("Open this entry in Changes"));
    expect(text(container.querySelector("h1"))).toBe("Changes");
    expect(container.querySelector('[data-entry="e1"]')?.className).toContain("bsw-sel");
  });

  test("seen: the same change is an ordinary row that still names the agent", () => {
    const { container } = mount();
    click(nav(container, "saving"));
    const row = container.querySelector('[data-key="snapshots.frequency"]') as HTMLElement;
    expect(row.className).not.toContain("bsw-agent");
    expect(text(row)).toContain("Changed by Claude Code");
    expect(text(row)).not.toContain("just now");
    expect(text(nav(container, "changes").querySelector(".bsw-cnt"))).toBe("9");
  });

  test("opening Changes and leaving it both report the time", () => {
    const seen: number[] = [];
    const { container } = mount({ changesSeenAt: seenBefore, now: nowJustAfter, onChangesSeen: (t) => seen.push(t) });
    click(nav(container, "changes"));
    expect(text(nav(container, "changes").querySelector(".bsw-cnt"))).toBe("1 new");
    expect(seen).toEqual([nowJustAfter]);
    click(nav(container, "general"));
    expect(seen).toEqual([nowJustAfter, nowJustAfter]);
    expect(text(nav(container, "changes").querySelector(".bsw-cnt"))).toBe("9");
  });
});

describe("Changes", () => {
  test("groups Today, Yesterday and Earlier; counts the filters from the core", () => {
    const { container } = mount();
    click(nav(container, "changes"));
    const heads = [...container.querySelectorAll(".bsw-pscroll > .bsw-card > .bsw-ch")].map((h) => text(h));
    expect(heads).toEqual(["Today", "Yesterday", "Earlier in October"]);
    const seg = [...container.querySelectorAll(".bsw-segf button")].map((b) => text(b));
    expect(seg).toEqual(["All 9", "You 6", "Agents 2", "App updates 1"]);
    expect(container.querySelectorAll("[data-entry]").length).toBe(9);
  });

  test("filter by who and by text", () => {
    const { container, getByText } = mount();
    click(nav(container, "changes"));
    click(getByText("Agents").closest("button"));
    expect([...container.querySelectorAll("[data-entry]")].map((e) => e.getAttribute("data-entry"))).toEqual(["e1", "e4"]);
    click(getByText("All").closest("button"));
    typeInto(container.querySelector('input[aria-label="Filter changes"]')!, "checkpoint");
    expect(container.querySelectorAll("[data-entry]").length).toBe(3);
    typeInto(container.querySelector('input[aria-label="Filter changes"]')!, "heading");
    expect([...container.querySelectorAll("[data-entry]")].map((e) => e.getAttribute("data-entry"))).toEqual(["e9"]);
    typeInto(container.querySelector('input[aria-label="Filter changes"]')!, "nothing like this");
    expect(text(container)).toContain("No changes match");
  });

  test("each entry shows old → new, who and when; a reset is tagged; Reset calls resetEntry", () => {
    const { container, calls } = mount();
    click(nav(container, "changes"));
    const e5 = container.querySelector('[data-entry="e5"]') as HTMLElement;
    expect(e5.className).toContain("bsw-isr");
    expect(text(e5)).toContain("Checkpoint on closeSaving & history");
    expect(text(e5)).toContain("ResetOffEvery close");
    expect(text(e5)).toContain("YouThu 15 Oct");
    const e9 = container.querySelector('[data-entry="e9"]') as HTMLElement;
    expect(text(e9)).toContain("Shortcut: Go to heading");
    expect(text(e9)).toContain("⇧⌘G");
    expect(text(e9)).toContain("⇧⌘O");
    click(e5.querySelector("button.bsw-rst"));
    expect(calls.resetEntry).toEqual([["e5"]]);
  });

  test("a key saved or removed reads Key connected / Key removed with who and when, and offers no Reset or Undo", () => {
    const base = wfState();
    const keyEntries = [
      { id: "k2", at: new Date(2026, 9, 19, 11, 2).getTime(), key: "accounts.speech", from: "connected", to: "missing", who: { kind: "agent", name: "Claude Code" } },
      { id: "k1", at: new Date(2026, 9, 19, 11, 0).getTime(), key: "accounts.speech", from: "missing", to: "connected", who: { kind: "you" } },
    ] as typeof base.changes;
    const { container, calls } = mount({ state: { ...base, changes: [...keyEntries, ...base.changes] } });
    click(nav(container, "changes"));
    const k1 = container.querySelector('[data-entry="k1"]') as HTMLElement;
    const k2 = container.querySelector('[data-entry="k2"]') as HTMLElement;
    expect(text(k1)).toContain("Speech service key");
    expect(text(k1)).toContain("Key connected");
    expect(text(k1)).toContain("You");
    expect(text(k2)).toContain("Key removed");
    expect(text(k2)).toContain("Claude Code");
    for (const row of [k1, k2]) {
      expect(text(row)).not.toContain("missing");
      expect(text(row)).not.toMatch(/Undo/);
      expect(row.querySelector("button.bsw-rst")).toBeNull();
    }
    click(k1);
    expect(insp(container).querySelector("button.bsw-rst")).toBeNull();
    // Every other entry is as before: e2 still has its Reset.
    expect(container.querySelector('[data-entry="e2"] button.bsw-rst')).not.toBeNull();
    expect(calls.resetEntry ?? []).toEqual([]);
  });

  test("empty: No changes yet, and the filters are inert", () => {
    const { container } = mount({ state: { ...wfState(), changes: [] } });
    click(nav(container, "changes"));
    expect(text(container)).toContain("No changes yet");
    expect(text(container)).toContain("Every setting has its default value.");
    expect((container.querySelector('input[aria-label="Filter changes"]') as HTMLInputElement).disabled).toBe(true);
    expect(nav(container, "changes").querySelector(".bsw-cnt")).toBeNull();
    expect(text(insp(container))).toContain("No change selected");
  });

  test("an import is one card with Undo import; the Imports filter appears; undo calls undoBatch with the batch", () => {
    const state = wfStateAfterImport();
    const { container, getByText, calls } = mount({ state, changesSeenAt: new Date(2026, 9, 19, 10, 40).getTime() });
    expect(text(nav(container, "changes").querySelector(".bsw-cnt"))).toBe("6 new");
    expect(nav(container, "changes").querySelector(".bsw-cnt")?.className).toContain("bsw-imp");
    click(nav(container, "changes"));
    const seg = [...container.querySelectorAll(".bsw-segf button")].map((b) => text(b));
    expect(seg).toEqual(["All 15", "You 6", "Agents 2", "App updates 1", "Imports 6"]);
    const card = container.querySelector(`[data-batch="${IMPORT_BATCH}"]`) as HTMLElement;
    expect(text(card.querySelector(".bsw-ch"))).toContain(`Import from ${IMPORT_FILE}`);
    expect(card.querySelectorAll("[data-entry]").length).toBe(6);
    expect(text(card)).toContain("Import");
    click(within(card).getByText("Undo import").closest("button"));
    expect(calls.undoBatch).toEqual([[IMPORT_BATCH]]);
    click(getByText("Imports").closest("button"));
    expect(container.querySelectorAll("[data-entry]").length).toBe(6);
    expect(container.querySelectorAll(".bsw-pscroll > .bsw-card").length).toBe(1);
  });

  test("selecting the import card shows the batch in the inspector: when, which Mac, counts, skipped, Undo, agent commands", () => {
    const { container, calls } = mount({ state: wfStateAfterImport() });
    click(nav(container, "changes"));
    click(container.querySelector(`[data-batch="${IMPORT_BATCH}"] .bsw-ch`));
    const a = insp(container);
    expect(text(a.querySelector(".bsw-nm"))).toBe("Import from file");
    expect(text(a.querySelector(".bsw-where"))).toBe(IMPORT_FILE);
    const kv = text(a.querySelector(".bsw-kv"));
    expect(kv).toContain("ImportedToday 10:52");
    expect(kv).toContain("Exported fromExample Mac");
    expect(kv).toContain("Exported onSat 17 Oct 18:04");
    expect(kv).toContain("Changed6 settings");
    expect(kv).toContain("Skipped1 setting");
    expect(text(a)).toContain("Workspace folder");
    expect(text(a)).toContain("~/Dropbox/Writing is not on this Mac.");
    expect([...a.querySelectorAll(".bsw-code span")].map((s) => text(s))).toEqual([`editorexample settings import ~/Downloads/'${IMPORT_FILE}'`, `editorexample settings undo-import ${IMPORT_BATCH}`]);
    click(within(a).getByText("Undo import").closest("button"));
    expect(calls.undoBatch).toEqual([[IMPORT_BATCH]]);
  });

  test("the copied undo command names the batch, quoted, even when it is the newest import", () => {
    const batch = "b 1'x";
    const s = wfStateAfterImport();
    s.changes = s.changes.map((e) => (e.batch === IMPORT_BATCH ? { ...e, batch } : e));
    const { container, calls } = mount({ state: s });
    click(nav(container, "changes"));
    click(container.querySelector(".bsw-card .bsw-imp"));
    const codes = [...insp(container).querySelectorAll(".bsw-code span")].map((x) => text(x));
    expect(codes[1]).toBe("editorexample settings undo-import 'b 1'\\''x'");
    expect(codes.join("\n")).not.toContain("--last");
    click(within(insp(container)).getByText("Undo import").closest("button"));
    expect(calls.undoBatch).toEqual([[batch]]);
  });

  test("an import lands on its card even when Changes was filtered to Agents with a search that matches nothing", async () => {
    const preview = wfImportPreview();
    const { container, getByText } = mount({
      state: wfStateAfterImport(),
      actions: {
        importPick: (() => ({ fileName: IMPORT_FILE, preview })) as never,
        importApply: (() => ({ ok: true, batch: IMPORT_BATCH })) as never,
      },
    });
    click(nav(container, "changes"));
    click(getByText("Agents").closest("button"));
    typeInto(container.querySelector('input[aria-label="Filter changes"]')!, "nothing like this");
    click(nav(container, "general"));
    click(getByText("Import settings…").closest("button"));
    await flush();
    click(within(container.querySelector('[role="dialog"]') as HTMLElement).getByText("Import 6 settings").closest("button"));
    await flush();
    const card = container.querySelector(`[data-batch="${IMPORT_BATCH}"]`) as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.className).toContain("bsw-sel");
  });
});

describe("Shortcuts", () => {
  const cmd = (root: HTMLElement, id: string): HTMLElement => root.querySelector(`[data-command="${id}"]`) as HTMLElement;
  const press = (row: HTMLElement, init: { code: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; key?: string }): void => {
    fireEvent.keyDown(row.querySelector(".bsw-rec")!, init);
  };

  test("lists the registry's commands by group with their chords as macOS writes them; a changed one says so", () => {
    const { container } = mount();
    click(nav(container, "shortcuts"));
    const heads = [...container.querySelectorAll(".bsw-pscroll > .bsw-card > .bsw-ch")].map((h) => text(h));
    expect(heads).toEqual(["Writing", "Navigation", "Read aloud"]);
    expect(text(cmd(container, "reading-focus").querySelector(".bsw-kbd"))).toBe("⌃⌘F");
    expect(text(cmd(container, "next-document").querySelector(".bsw-kbd"))).toBe("⌥⌘]");
    const gh = cmd(container, "go-to-heading");
    expect(text(gh)).toContain("Changed");
    expect(text(gh.querySelector(".bsw-kbd"))).toBe("⇧⌘O");
    expect(text(container.querySelector(".bsw-phead .bsw-meta"))).toBe("1 changed");
  });

  test("search narrows by label or group", () => {
    const { container } = mount();
    click(nav(container, "shortcuts"));
    typeInto(container.querySelector('input[aria-label="Search commands"]')!, "read aloud");
    expect([...container.querySelectorAll("[data-command]")].map((e) => e.getAttribute("data-command"))).toEqual(["read-aloud", "skip-sentence"]);
  });

  test("rebinding to a free chord goes straight through", () => {
    const { container, calls } = mount();
    click(nav(container, "shortcuts"));
    click(cmd(container, "insert-link").querySelector(".bsw-kbd"));
    expect(text(cmd(container, "insert-link"))).toContain("Default ⌘L");
    press(cmd(container, "insert-link"), { code: "KeyJ", metaKey: true, shiftKey: true });
    expect(calls.rebind).toEqual([["insert-link", "⌘⇧J"]]);
    expect(container.querySelector(".bsw-rec")).toBeNull();
  });

  test("a clash asks Swap, Replace or Cancel; Swap gives the other command this one's chord", () => {
    const { container, calls } = mount();
    click(nav(container, "shortcuts"));
    click(cmd(container, "reading-focus").querySelector(".bsw-kbd"));
    press(cmd(container, "reading-focus"), { code: "KeyT", metaKey: true });
    const row = cmd(container, "reading-focus");
    expect(row.className).toContain("bsw-ch2");
    expect(text(row)).toContain("⌘T is used by Typewriter mode.");
    expect(calls.rebind).toBeUndefined();
    click(within(row).getByText("Swap").closest("button"));
    expect(calls.rebindMany).toEqual([[[{ commandId: "reading-focus", chord: "⌘T" }, { commandId: "typewriter-mode", chord: "⌘⌃F" }]]]);
    expect(container.querySelector(".bsw-ch2")).toBeNull();
  });

  test("Replace takes the chord and leaves the other command with none", () => {
    const { container, calls } = mount();
    click(nav(container, "shortcuts"));
    click(cmd(container, "reading-focus").querySelector(".bsw-kbd"));
    press(cmd(container, "reading-focus"), { code: "KeyT", metaKey: true });
    click(within(cmd(container, "reading-focus")).getByText("Replace").closest("button"));
    expect(calls.rebindMany).toEqual([[[{ commandId: "reading-focus", chord: "⌘T" }, { commandId: "typewriter-mode", chord: "" }]]]);
  });

  test("Cancel drops the clash and changes nothing", () => {
    const { container, calls } = mount();
    click(nav(container, "shortcuts"));
    click(cmd(container, "reading-focus").querySelector(".bsw-kbd"));
    press(cmd(container, "reading-focus"), { code: "KeyT", metaKey: true });
    click(within(cmd(container, "reading-focus")).getByText("Cancel").closest("button"));
    expect(container.querySelector(".bsw-ch2")).toBeNull();
    expect(calls.rebind).toBeUndefined();
    expect(calls.rebindMany).toBeUndefined();
  });

  test("a chord the estate keeps is refused with the registry's words and offers only Cancel", () => {
    const { container, calls } = mount();
    click(nav(container, "shortcuts"));
    click(cmd(container, "reading-focus").querySelector(".bsw-kbd"));
    press(cmd(container, "reading-focus"), { code: "KeyF", metaKey: true });
    const row = cmd(container, "reading-focus");
    expect(text(row)).toContain("is kept for");
    expect(within(row).queryByText("Swap")).toBeNull();
    expect(calls.rebindMany).toBeUndefined();
  });

  test("Esc stops recording; Backspace removes the shortcut", () => {
    const { container, calls } = mount();
    click(nav(container, "shortcuts"));
    click(cmd(container, "insert-link").querySelector(".bsw-kbd"));
    press(cmd(container, "insert-link"), { code: "Escape", key: "Escape" });
    expect(container.querySelector(".bsw-rec")).toBeNull();
    click(cmd(container, "insert-link").querySelector(".bsw-kbd"));
    press(cmd(container, "insert-link"), { code: "Backspace", key: "Backspace" });
    expect(calls.rebind).toEqual([["insert-link", ""]]);
  });

  test("Reset on a changed shortcut and Reset all… act on shortcuts", () => {
    const { container, getByText, calls } = mount();
    click(nav(container, "shortcuts"));
    click(within(cmd(container, "go-to-heading")).getByText("Reset").closest("button"));
    expect(calls.reset).toEqual([[{ commandId: "go-to-heading" }]]);
    click(getByText("Reset all…").closest("button"));
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(text(dialog)).toContain("1 shortcut return to their defaults.");
    click(within(dialog).getByText("Reset 1 setting").closest("button"));
    expect(calls.resetSection).toEqual([["shortcuts"]]);
  });

  test("the inspector shows the command: default, current, where it appears, and the agent command", () => {
    const { container } = mount();
    click(nav(container, "shortcuts"));
    click(cmd(container, "insert-link"));
    const a = insp(container);
    expect(text(a.querySelector(".bsw-nm"))).toBe("Insert link");
    expect(text(a.querySelector(".bsw-where"))).toBe("Shortcuts › Writing");
    expect(text(a)).toContain("Turns the selected text into a link.");
    expect(text(a)).toContain("MenuFormat › Insert link");
    expect(text(a)).toContain("Command paletteYes");
    expect(a.querySelector(".bsw-code")).toBeNull();
  });

  test("the agent commands for a shortcut are left out unless asked for", () => {
    const { container } = mount({ agentCommandsForShortcuts: false });
    click(nav(container, "shortcuts"));
    click(cmd(container, "insert-link"));
    expect(insp(container).querySelector(".bsw-code")).toBeNull();
  });

  test("a fixed command shows its chord but cannot be recorded", () => {
    const { container } = mount({ showCommand: () => true });
    click(nav(container, "shortcuts"));
    const kbd = cmd(container, "settings").querySelector(".bsw-kbd") as HTMLButtonElement;
    expect(kbd.disabled).toBe(true);
    expect(kbd.textContent).toBe("⌘,");
  });
});

describe("Accounts and keys", () => {
  test("lists slots by group with their status; never a value", () => {
    const { container } = mount({ slots: [
      { id: "a", label: "Anthropic", kind: "account", status: "connected", detail: "Signed in · plan subscription", group: "Model provider" },
      { id: "r", label: "Readwise", status: "missing" },
      { id: "s", label: "Speech service", status: "problem", detail: "Key rejected by the service." },
      { id: "k", label: "Keyed", status: "connected", last4: "9f3a" },
    ] });
    click(nav(container, "accounts"));
    const heads = [...container.querySelectorAll(".bsw-pscroll > .bsw-card > .bsw-ch")].map((h) => text(h));
    expect(heads).toEqual(["Model provider", "Services"]);
    const svc = (id: string) => container.querySelector(`[data-slot="${id}"]`) as HTMLElement;
    expect(text(svc("a"))).toContain("Signed in · plan subscription");
    expect(text(svc("r"))).toContain("Not connected");
    expect(text(svc("s"))).toContain("Key rejected by the service.");
    expect(text(svc("k"))).toContain("Connected · ends in 9f3a");
  });

  test("Sign out, Replace key… and Remove call the host", () => {
    const { container, calls } = mount();
    click(nav(container, "accounts"));
    click(within(container.querySelector('[data-slot="accounts.anthropic"]') as HTMLElement).getByText("Sign out").closest("button"));
    expect(calls.signOut).toEqual([["accounts.anthropic"]]);
    click(within(container.querySelector('[data-slot="accounts.speech"]') as HTMLElement).getByText("Remove").closest("button"));
    expect(calls.removeSecret).toEqual([["accounts.speech"]]);
  });

  test("a key typed in is handed over once, then cleared; it is never in the page", async () => {
    const SECRET = "fake-sentinel-value-for-test";
    const { container, calls, getByText } = mount();
    click(nav(container, "accounts"));
    click(getByText("Add key…").closest("button"));
    const input = container.querySelector('input[type="password"]') as HTMLInputElement;
    expect(container.innerHTML).not.toContain("The key is not shown again");
    expect((getByText("Add key").closest("button") as HTMLButtonElement).disabled).toBe(true);
    typeInto(input, SECRET);
    click(getByText("Add key").closest("button"));
    await flush();
    expect(calls.setSecret).toEqual([["accounts.readwise", SECRET]]);
    expect(container.innerHTML).not.toContain(SECRET);
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });

  test("a secret row never shows a value, whatever the slot holds", () => {
    const { container } = mount({ slots: [{ id: "accounts.speech", label: "Speech service", status: "connected", last4: "0000", detail: "Key saved" }] });
    click(nav(container, "readaloud"));
    const row = container.querySelector('[data-key="accounts.speech"]') as HTMLElement;
    expect(text(row)).toContain("••••••••");
    expect(text(row)).toContain("Saved in Keychain");
    expect(row.innerHTML).not.toContain("0000");
    click(within(row).getByText("Replace…").closest("button"));
    expect(text(container.querySelector("h1"))).toBe("Accounts and keys");
    expect(container.querySelector('input[type="password"]')).toBeTruthy();
  });

  test("the inspector for a slot says where it is stored and what uses it", () => {
    const { container } = mount();
    click(nav(container, "accounts"));
    click(container.querySelector('[data-slot="accounts.readwise"]'));
    const a = insp(container);
    expect(text(a.querySelector(".bsw-nm"))).toBe("Readwise");
    expect(text(a.querySelector(".bsw-kv"))).toContain("StatusNot connected");
    expect(text(a)).toContain("Stored inKeychain");
    expect(text(a)).toContain("In settings fileNo");
    expect(text(a)).toContain("LibraryImport highlights");
    expect(text(a)).toContain("editorexample settings get accounts.readwise --json");
  });
});

describe("About", () => {
  test("shows the version, copies it, shows the update status and offers a check", () => {
    const copied: string[] = [];
    const { container, getByText, calls } = mount({ onCopy: (t) => copied.push(t) });
    click(nav(container, "about"));
    expect(text(container)).toContain("Version 0.31.4 (build 2810)");
    expect(text(container)).toContain("Example Editor is up to date");
    click(getByText("Copy version").closest("button"));
    expect(copied).toEqual(["Example Editor 0.31.4 (build 2810)"]);
    click(getByText("Check for updates").closest("button"));
    expect(calls.checkForUpdates).toEqual([[]]);
  });

});

describe("Settings file: export and import", () => {
  test("Export settings… asks the host", () => {
    const { getByText, calls } = mount();
    click(getByText("Export settings…").closest("button"));
    expect(calls.exportSettings).toEqual([[]]);
  });

  test("Import settings… shows the preview sheet: count, old → new, skipped with reason, already match; Import applies exactly that preview", async () => {
    const preview = wfImportPreview();
    const { container, getByText, calls } = mount({ actions: { importPick: (() => ({ fileName: IMPORT_FILE, preview })) as never } });
    click(getByText("Import settings…").closest("button"));
    await flush();
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(text(dialog)).toContain(`Import settings from “${IMPORT_FILE}”?`);
    expect(text(dialog)).toContain("Exported from Example Mac on Sat 17 Oct 2026 at 18:04 · Example Editor 0.31.2");
    expect(text(dialog)).toContain("6 settings will change");
    const rows = [...dialog.querySelectorAll(".bsw-pr:not(.bsw-skip)")].map((r) => text(r));
    expect(rows).toEqual([
      "Prose sizeEditor18 pt20 pt", "Line widthEditorMediumWide", "Typing soundsSoundsOnOff", "Keep history forSaving & history30 days90 days",
      "Default reasoning levelAssistantMediumHigh", "Shortcut: Typewriter modeShortcuts⌘T⌃⌘T",
    ]);
    expect(text(dialog.querySelector(".bsw-skip"))).toContain("Workspace folder");
    expect(text(dialog.querySelector(".bsw-skip"))).toContain("~/Dropbox/Writing is not on this Mac.");
    expect(preview.alreadyMatch).toBe(11);
    expect(text(dialog)).toContain("11 other settings in the file already match this Mac.");
    expect(text(dialog)).toContain("Account keys are not in the file.");
    click(within(dialog).getByText("Import 6 settings").closest("button"));
    expect(calls.importApply).toEqual([[preview, IMPORT_FILE]]);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  test("Cancel on the preview imports nothing", async () => {
    const preview = wfImportPreview();
    const { container, getByText, calls } = mount({ actions: { importPick: (() => ({ fileName: IMPORT_FILE, preview })) as never } });
    click(getByText("Import settings…").closest("button"));
    await flush();
    click(within(container.querySelector('[role="dialog"]') as HTMLElement).getByText("Cancel").closest("button"));
    expect(calls.importApply).toBeUndefined();
  });

  test("another app's file is refused with a sheet that names it, and Choose another file… picks again", async () => {
    const tw = exportFile(twState(), { appVersion: "0.41.0", hostName: "Example Mac", now: NOW, schema: twSchema, commands: wfAdapter });
    const refused: ImportPreview = previewImport(wfState(), tw, { schema: wfSchema, commands: wfAdapter });
    expect(refused.refused?.code).toBe("other-app");
    let picks = 0;
    const { container, getByText } = mount({
      appNames: { recorderexample: "Example Recorder" },
      actions: { importPick: (() => (++picks === 1 ? { fileName: "Example Recorder Settings 2026-10-12.json", preview: refused } : null)) as never },
    });
    click(getByText("Import settings…").closest("button"));
    await flush();
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(text(dialog)).toContain("This file holds Example Recorder settings");
    expect(text(dialog)).toContain("“Example Recorder Settings 2026-10-12.json” cannot be imported into Example Editor. Choose a Example Editor settings file.");
    click(within(dialog).getByText("Choose another file…").closest("button"));
    await flush();
    expect(picks).toBe(2);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  test("a file that is not a settings file at all is refused in the core's words", async () => {
    const refused = previewImport(wfState(), "{not json", { schema: wfSchema, commands: wfAdapter });
    const { container, getByText } = mount({ actions: { importPick: (() => ({ fileName: "notes.txt", preview: refused })) as never } });
    click(getByText("Import settings…").closest("button"));
    await flush();
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(text(dialog)).toContain("This file cannot be imported");
    expect(text(dialog)).toContain(refused.refused!.message);
  });
});

describe("the window follows the core, not its own logic", () => {
  test("the batch the core's applyImport writes renders as an import card with its skipped item", () => {
    const state = wfState();
    const preview = previewImport(state, wfImportFile(), { schema: wfSchema, commands: wfAdapter });
    let n = 0;
    const r = applyImport(state, preview, { file: IMPORT_FILE }, { schema: wfSchema, commands: wfAdapter, now: () => NOW - 3 * 60_000, newId: () => `x${++n}` });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { container } = mount({ state: r.state });
    click(nav(container, "changes"));
    const card = container.querySelector(".bsw-card .bsw-imp") as HTMLElement;
    expect(text(card)).toContain(`Import from ${IMPORT_FILE}`);
    expect(container.querySelectorAll("[data-batch] [data-entry]").length).toBe(6);
    click(card);
    expect(text(insp(container))).toContain("~/Dropbox/Writing is not on this Mac.");
  });

  test("counts in the window equal the core's", () => {
    const state = wfState();
    const { container } = mount({ state });
    click(nav(container, "changes"));
    const counts = changeCounts(state);
    const seg = [...container.querySelectorAll(".bsw-segf button")].map((b) => text(b));
    expect(container.querySelector(".bsw-segf button")?.getAttribute("aria-label")).toBe(`All, ${counts.all} ${counts.all === 1 ? "change" : "changes"}`);
    expect(seg[0]).toBe(`All ${counts.all}`);
    expect(seg[1]).toBe(`You ${counts.you}`);
    expect(seg[2]).toBe(`Agents ${counts.agent}`);
    expect(seg[3]).toBe(`App updates ${counts["app-update"]}`);
  });

  test("Example Recorder in the same window: its own sections, rows and agent command name", () => {
    const { container } = mount({ schema: twSchema, state: twState(), registry: twRegistry, appInfo: { name: "Example Recorder", version: "0.41.0" }, slots: [], rowHints: {} });
    expect(text(container.querySelectorAll(".bsw-grp")[1])).toBe("Example Recorder");
    click(nav(container, "presenting"));
    click(container.querySelector('[data-key="clock.darkAmber"]'));
    expect(text(container.querySelector(".bsw-code span"))).toBe("recorderexample settings set clock.darkAmber 2");
    expect(text(container.querySelector(".bsw-phead .bsw-meta"))).toBe("1 changed from default");
  });
});

test("the About Updates slot renders the shared update card", async () => {
  const latest = { version: "1.2.0", released: "2026-10-21", summary: ["One change."], notes: "https://editor.example/notes", download: { mac: "https://editor.example/mac", windows: "https://editor.example/windows" } };
  const snap = { identity: { appName: "Example Editor", feedUrl: "https://editor.example/updates.json" }, running: "1.1.0", platform: "darwin", source: "website" as const, enabled: true, checking: false, busy: false, waiting: false, state: { latest }, mark: latest, whatsNew: null };
  const noop = async () => {};
  const m = mount({ initial: { section: "about" }, updateCard: <SettingsUpdatesCard snapshot={snap} actions={ { check: async () => snap, setEnabled: noop, download: noop, notNow: noop, skip: noop, stopSkipping: noop, openNotes: noop, openStore: noop, dismissWhatsNew: noop, loadNotes: async () => null, showNotes: () => {} }} /> });
  await flush();
  expect(m.getByRole("switch", { name: "Check for new versions" })).not.toBeNull();
  expect(m.getByText(/internet address/).textContent).toContain("editor.example");
});


test('legacy update checker requires host declaration and reports rejection visibly', async () => {
  const m = mount({ initial: { section: 'about' }, appInfo: { name: 'Old app', version: '1.0.0', canCheckForUpdates: false } });
  await flush();
  expect(m.queryByRole('button', { name: 'Check for updates' })).toBeNull();
  m.unmount();
  const rejected = mount({ initial: { section: 'about' }, actions: { checkForUpdates: async () => { throw Error('Update service unavailable'); } } });
  await flush();
  fireEvent.click(rejected.getByRole('button', { name: 'Check for updates' }));
  await flush();
  expect(rejected.getByText('Update service unavailable')).not.toBeNull();
});
