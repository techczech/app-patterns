/** Mounts the window on the demo fixture with recording actions, for the tests. */
import { fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { SettingsWindow } from "./settings-window.tsx";
import type { Outcome, SettingsActions, SettingsWindowProps } from "./types.ts";
import {
  FRAME_COMMANDS, NOW, wfCommandHelp, wfHints, wfMenus, wfRegistry, wfSchema, wfSlots, wfState,
} from "../demo/fixture.ts";

export type Calls = Record<string, unknown[][]>;

export function recordingActions(overrides: Partial<SettingsActions> = {}): { actions: SettingsActions; calls: Calls } {
  const calls: Calls = {};
  const ok: Outcome = { ok: true };
  const rec = <K extends keyof SettingsActions>(name: K, ret: unknown = ok) => (...args: unknown[]) => { (calls[name] ??= []).push(args); return ret; };
  const actions = {
    set: rec("set"), rebind: rec("rebind"), rebindMany: rec("rebindMany"), reset: rec("reset"), resetSection: rec("resetSection"), resetAll: rec("resetAll"),
    resetEntry: rec("resetEntry"), undoBatch: rec("undoBatch"), exportSettings: rec("exportSettings"), importPick: rec("importPick", null),
    importApply: rec("importApply"), setSecret: rec("setSecret"), removeSecret: rec("removeSecret"), signOut: rec("signOut"),
    choosePath: rec("choosePath", null), checkForUpdates: rec("checkForUpdates", undefined),
    ...overrides,
  } as unknown as SettingsActions;
  return { actions, calls };
}

export function mount(over: Omit<Partial<SettingsWindowProps>, "actions"> & { actions?: Partial<SettingsActions> } = {}) {
  const { actions: actionOverrides, ...props } = over;
  const { actions, calls } = recordingActions(actionOverrides);
  const full: SettingsWindowProps = {
    schema: wfSchema, state: wfState(), registry: wfRegistry, appInfo: { canCheckForUpdates: true, name: "Example Editor", version: "0.31.4", build: "2810", icon: "pen-line" },
    slots: wfSlots(), rowHints: wfHints, menus: wfMenus, commandHelp: wfCommandHelp, now: NOW, actions,
    showCommand: (d) => !FRAME_COMMANDS.has(d.id) && !d.hidden,
    update: { text: "Example Editor is up to date", detail: "Last checked today at 09:41." },
    ...props,
  };
  const r = render(createElement(SettingsWindow, full));
  return { ...r, calls, props: full };
}

/** The text of every row of a pane, by key. */
export const rowKeys = (root: HTMLElement): string[] => [...root.querySelectorAll("[data-key]")].map((e) => e.getAttribute("data-key") ?? "");

/**
 * Types into a text field the way a person does: focus, a new value, then the input and key-up events. react-dom decides at load time
 * whether it hears the `input` event or watches focus and key-up, and a test process may have loaded it either way.
 */
export function typeInto(input: HTMLInputElement | Element | null, value: string): void {
  const el = input as HTMLInputElement;
  el.focus();
  fireEvent.focusIn(el); // a test blur does not move focus, so say it again
  const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
  set?.call(el, value);
  fireEvent.input(el);
  fireEvent.keyUp(el);
}
