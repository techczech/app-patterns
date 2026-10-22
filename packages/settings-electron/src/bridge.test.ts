import { describe, expect, test } from "bun:test";
import type { ImportPreview } from "@app-patterns/settings";
import type { SettingsActions, SettingsWindowProps, Slot, AppInfo } from "@app-patterns/settings-react";
import { createSettingsBridge, type SettingsBridge } from "./bridge.ts";
import { CHANNELS, type SettingsView } from "./channels.ts";
import type { IpcRendererLike } from "./electron-types.ts";
import type { SlotInfo } from "./secret-slots.ts";

// ---- type level: the bridge is exactly the host interface settings-react expects -----------------------------------------------------

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

/** Every action the window may call, the optional ones included, except the two that are an app's own (sign-out, update check). */
type HostActions = Required<Omit<SettingsActions, "signOut" | "checkForUpdates">>;
export type BridgeHasEveryAction = Assert<Equal<Pick<SettingsBridge, keyof HostActions>, HostActions>>;
/** The bridge passes as `actions` unchanged. */
const asActions = (b: SettingsBridge): SettingsWindowProps["actions"] => b;
/** The view fills the window's props. */
export type ViewFitsProps = Assert<Equal<SettingsView["state"], SettingsWindowProps["state"]>>;
export type SlotsFitProps = Assert<SettingsView["slots"] extends NonNullable<SettingsWindowProps["slots"]> ? true : false>;
export type AppInfoFitsProps = Assert<Equal<SettingsView["appInfo"], AppInfo>>;
/** The slots main sends are window slots (no value field). */
export type SlotInfoIsSlot = Assert<SlotInfo extends Slot ? true : false>;
export type NoValueInSlot = Assert<"value" extends keyof SlotInfo ? false : true>;

// ---- runtime: each method calls its channel with checked arguments ----------------------------------------------------------------

function fakeIpc() {
  const calls: { channel: string; args: unknown[] }[] = [];
  const listeners = new Map<string, Set<(e: unknown, ...a: unknown[]) => void>>();
  const ipc: IpcRendererLike & { emit(channel: string, value: unknown): void } = {
    invoke: async (channel, ...args) => {
      calls.push({ channel, args });
      return channel === CHANNELS.importPreview ? null : { ok: true };
    },
    on: (c, l) => listeners.set(c, (listeners.get(c) ?? new Set()).add(l)),
    removeListener: (c, l) => listeners.get(c)?.delete(l),
    emit: (c, v) => {
      for (const l of listeners.get(c) ?? []) l({}, v);
    },
  };
  return { ipc, calls, listeners };
}

describe("createSettingsBridge", () => {
  test("every action invokes its bridle-settings: channel", async () => {
    const { ipc, calls } = fakeIpc();
    const b = createSettingsBridge(ipc);
    const preview = { changes: [], skipped: [], alreadyMatch: 0 } as ImportPreview;
    await b.view();
    await b.set("editor.size", 20);
    await b.rebind("rename", "⌘E");
    await b.rebindMany([{ commandId: "rename", chord: "⌘G" }]);
    await b.reset("editor.size");
    await b.reset({ commandId: "rename" });
    await b.resetSection("editor");
    await b.resetAll();
    await b.resetEntry("e1");
    await b.undoBatch("b1");
    await b.exportSettings();
    await b.importPick();
    await b.importApply(preview, "file.json");
    await b.setSecret("accounts.openai", "sk-x");
    await b.removeSecret("accounts.openai");
    await b.choosePath("general.folder");
    expect(calls).toEqual([
      { channel: CHANNELS.view, args: [] },
      { channel: CHANNELS.set, args: ["editor.size", 20] },
      { channel: CHANNELS.rebind, args: ["rename", "⌘E"] },
      { channel: CHANNELS.rebindMany, args: [[{ commandId: "rename", chord: "⌘G" }]] },
      { channel: CHANNELS.reset, args: ["editor.size"] },
      { channel: CHANNELS.reset, args: [{ commandId: "rename" }] },
      { channel: CHANNELS.resetSection, args: ["editor"] },
      { channel: CHANNELS.resetAll, args: [] },
      { channel: CHANNELS.resetEntry, args: ["e1"] },
      { channel: CHANNELS.undoBatch, args: ["b1"] },
      { channel: CHANNELS.export, args: [] },
      { channel: CHANNELS.importPreview, args: [] },
      { channel: CHANNELS.importApply, args: ["file.json"] }, // the preview stays in the page; main applies its own
      { channel: CHANNELS.setSecret, args: ["accounts.openai", "sk-x"] },
      { channel: CHANNELS.removeSecret, args: ["accounts.openai"] },
      { channel: CHANNELS.choosePath, args: ["general.folder"] },
    ]);
    expect(asActions(b)).toBe(b);
  });

  test("onChanged and onSection subscribe and unsubscribe", () => {
    const { ipc, listeners } = fakeIpc();
    const b = createSettingsBridge(ipc);
    const seen: unknown[] = [];
    const off = b.onChanged((v) => seen.push(v));
    const offSection = b.onSection((r) => seen.push(r));
    ipc.emit(CHANNELS.changed, { state: 1 });
    ipc.emit(CHANNELS.section, { section: "about" });
    off();
    offSection();
    ipc.emit(CHANNELS.changed, { state: 2 });
    expect(seen).toEqual([{ state: 1 }, { section: "about" }]);
    expect(listeners.get(CHANNELS.changed)?.size).toBe(0);
  });

  test("offers no way to read a key", () => {
    const b = createSettingsBridge(fakeIpc().ipc);
    const names = Object.keys(b);
    expect(names.filter((n) => /get|read|reveal/i.test(n))).toEqual([]);
    expect(Object.values(CHANNELS).filter((c) => /secret/i.test(c)).sort()).toEqual([CHANNELS.removeSecret, CHANNELS.setSecret].sort());
  });
});

test("checkForUpdates invokes its dedicated channel without arguments", async () => {
  const { ipc, calls } = fakeIpc();
  await createSettingsBridge(ipc).checkForUpdates();
  expect(calls).toEqual([{ channel: CHANNELS.checkForUpdates, args: [] }]);
});
