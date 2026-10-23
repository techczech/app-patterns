/** Conflict choices are checked against the real Settings operation and command resolver. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createElement } from "react";
import { defineRegistry } from "@app-patterns/commands";
import { commandsAdapter, defineSchema, emptyState, loadState, rebindMany, type SettingsState } from "@app-patterns/settings";
import { mount } from "./mount.test-support.tsx";
import { SettingsWindow } from "./settings-window.tsx";
import { installDom } from "./test-dom.ts";

let restoreDom: () => void;
beforeEach(() => { restoreDom = installDom(); });
afterEach(() => { cleanup(); restoreDom(); });

const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve(); }); };
type Pairs = Parameters<typeof rebindMany>[1];

function fixture(keys: Record<string, string> = {}, fixedRefresh = false) {
  const registry = defineRegistry([
    { id: "refresh", group: "App", label: "Refresh", key: "⌘R", icon: "refresh-cw", ...(fixedRefresh ? { fixed: true as const } : {}) },
    { id: "pin", group: "App", label: "Pin", key: "⌘D", icon: "pin" },
  ], { rebindableEstateDefaults: true });
  const schema = defineSchema({ app: "conflict-test", settings: [] });
  let ids = 0;
  const context = { schema, commands: commandsAdapter(registry), who: { kind: "you" } as const, now: () => 1, newId: () => `change-${++ids}` };
  let state: SettingsState = { ...emptyState(schema.app), keys };
  const calls: Pairs[] = [];
  const apply = (pairs: Pairs) => {
    const result = rebindMany(state, pairs, context);
    if (result.ok) state = result.state;
    return result;
  };
  const m = mount({ schema, registry, state, showCommand: () => true, rowHints: {}, slots: [], menus: [],
    initial: { section: "shortcuts" }, actions: { rebindMany: (pairs) => { calls.push(pairs); const result = apply(pairs); renderState(); return result; } },
  });
  const renderState = () => m.rerender(createElement(SettingsWindow, { ...m.props, state }));
  const row = (id: string) => m.container.querySelector(`[data-command="${id}"]`) as HTMLElement;
  const record = (id: string, code: string, altKey = false) => {
    fireEvent.click(row(id).querySelector(".bsw-kbd")!);
    fireEvent.keyDown(row(id).querySelector(".bsw-rec")!, { code, metaKey: true, altKey });
  };
  const button = (id: string, name: string) => within(row(id)).getByRole("button", { name }) as HTMLButtonElement;
  return { ...m, registry, context, calls, apply, renderState, row, record, button, state: () => state, ids: () => ids };
}

for (const [id, key] of [["settings", "⌘,"], ["cheat", "⌘/"]] as const) {
  test(`${id}: reserved return chord disables Swap with the operation's reason; Replace persists`, async () => {
    const f = fixture();
    const before = JSON.stringify(f.state());
    const refused = rebindMany(f.state(), [{ commandId: id, chord: "⌘R" }, { commandId: "refresh", chord: key }], f.context);
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("Expected reserved-chord refusal");
    f.record(id, "KeyR");
    expect(f.button(id, "Swap").disabled).toBe(true);
    expect(f.row(id).textContent).toContain(refused.error);
    expect(f.button(id, "Replace").disabled).toBe(false);
    fireEvent.click(f.button(id, "Swap"));
    expect(f.calls).toEqual([]);
    expect(JSON.stringify(f.state())).toBe(before);
    expect(f.ids()).toBe(0);
    fireEvent.click(f.button(id, "Replace"));
    await flush();
    expect(f.calls).toEqual([[{ commandId: id, chord: "⌘R" }, { commandId: "refresh", chord: "" }]]);
    const loaded = loadState(JSON.parse(JSON.stringify(f.state())), { ...f.context, appVersion: "1" });
    expect(loaded.entries).toEqual([]);
    expect(loaded.state.keys).toEqual({ [id]: "⌘R", refresh: "" });
    expect(f.registry.resolveBindings(loaded.state.keys).bindings[id]).toBe("⌘R");
  });
}

for (const id of ["settings", "pin"]) {
  test(`${id}: a swap of custom unreserved chords persists and reloads`, async () => {
    const f = fixture({ [id]: "⌘⌥G", refresh: "⌘⌥R" });
    const before = JSON.stringify(f.state());
    f.record(id, "KeyR", true);
    expect(f.button(id, "Swap").disabled).toBe(false);
    expect(JSON.stringify(f.state())).toBe(before);
    expect(f.ids()).toBe(0);
    expect(f.calls).toEqual([]);
    fireEvent.click(f.button(id, "Swap"));
    await flush();
    const loaded = loadState(JSON.parse(JSON.stringify(f.state())), { ...f.context, appVersion: "1" });
    expect(loaded.entries).toEqual([]);
    expect(loaded.state.keys).toEqual({ [id]: "⌘⌥R", refresh: "⌘⌥G" });
    expect(f.registry.resolveBindings(loaded.state.keys).bindings).toMatchObject({ [id]: "⌘⌥R", refresh: "⌘⌥G" });
    expect(f.state().changes).toHaveLength(2);
    expect(f.state().changes[0]?.batch).toBe(f.state().changes[1]?.batch);
  });
}

test("an open conflict re-evaluates both its return chord and the current holder without preview writes", async () => {
  const f = fixture();
  f.record("settings", "KeyR");
  expect(f.button("settings", "Swap").disabled).toBe(true);
  expect(f.apply([{ commandId: "settings", chord: "⌘⌥G" }, { commandId: "refresh", chord: "⌘D" }, { commandId: "pin", chord: "⌘R" }]).ok).toBe(true);
  const saved = JSON.stringify(f.state());
  const ids = f.ids();
  f.renderState();
  expect(f.row("settings").textContent).toContain("⌘R is used by Pin.");
  expect(f.button("settings", "Swap").disabled).toBe(false);
  expect(f.row("settings").textContent).not.toContain("is kept for");
  expect(JSON.stringify(f.state())).toBe(saved);
  expect(f.ids()).toBe(ids);
  expect(f.calls).toEqual([]);
  fireEvent.click(f.button("settings", "Swap"));
  await flush();
  expect(f.calls).toEqual([[{ commandId: "settings", chord: "⌘R" }, { commandId: "pin", chord: "⌘⌥G" }]]);
  expect(f.state().keys).toEqual({ settings: "⌘R", pin: "⌘⌥G", refresh: "⌘D" });
});

test("a conflict disables Swap again when a changed binding returns to its reserved default", () => {
  const f = fixture({ settings: "⌘⌥G" });
  f.record("settings", "KeyR");
  expect(f.button("settings", "Swap").disabled).toBe(false);
  expect(f.apply([{ commandId: "settings", chord: "⌘," }]).ok).toBe(true);
  f.renderState();
  expect(f.button("settings", "Swap").disabled).toBe(true);
  expect(f.row("settings").textContent).toContain("is kept for");
  expect(f.button("settings", "Replace").disabled).toBe(false);
});

test("a fixed holder keeps the existing refusal without offering conflict actions", () => {
  const f = fixture({}, true);
  const before = JSON.stringify(f.state());
  const refused = rebindMany(f.state(), [{ commandId: "settings", chord: "⌘R" }, { commandId: "refresh", chord: "" }], f.context);
  expect(refused.ok).toBe(false);
  if (refused.ok) throw new Error("Expected fixed-chord refusal");
  f.record("settings", "KeyR");
  expect(within(f.row("settings")).queryByRole("button", { name: "Replace" })).toBeNull();
  expect(within(f.row("settings")).queryByRole("button", { name: "Swap" })).toBeNull();
  expect(f.row("settings").textContent).toContain("is kept for “Refresh”");
  expect(JSON.stringify(f.state())).toBe(before);
  expect(f.calls).toEqual([]);
});

test("the actual operation remains authoritative if bindings change after the rendered preview", async () => {
  const f = fixture({ settings: "⌘⌥G" });
  f.record("settings", "KeyR");
  expect(f.button("settings", "Swap").disabled).toBe(false);
  // Simulate another writer committing before its new snapshot reaches this renderer.
  expect(f.apply([{ commandId: "settings", chord: "⌘⌥H" }, { commandId: "pin", chord: "⌘⌥G" }]).ok).toBe(true);
  const saved = JSON.stringify(f.state());
  const refused = rebindMany(f.state(), [{ commandId: "settings", chord: "⌘R" }, { commandId: "refresh", chord: "⌘⌥G" }], f.context);
  if (refused.ok) throw new Error("Expected concurrent collision refusal");
  fireEvent.click(f.button("settings", "Swap"));
  await flush();
  expect(f.calls).toHaveLength(1);
  expect(JSON.stringify(f.state())).toBe(saved);
  expect(f.container.textContent).toContain(refused.error);
});
