/**
 * The Settings window's side of the IPC: what the preload exposes, built over `ipcRenderer`. It implements `@app-patterns/settings-react`'s
 * `SettingsActions` exactly (so `actions={window.bridleSettings}` works), plus `view`, `onChanged` and `onSection` to feed the window's
 * props. No Node or Electron import here: the preload runs sandboxed.
 *
 * `importApply` sends only the file name: main applies the preview it made itself, never one handed back by the page.
 * There is no way to read a key: `setSecret` sends one to main and returns only whether it was saved.
 */
import type { ImportPreview, SettingValue } from "@app-patterns/settings";
import type { Outcome, SettingsActions } from "@app-patterns/settings-react";
import { CHANNELS, type SectionRequest, type SettingsView } from "./channels.ts";
import type { IpcRendererLike } from "./electron-types.ts";

export interface SettingsBridge extends Required<Omit<SettingsActions, "signOut" | "checkForUpdates">> {
  /** Everything the window shows now (state, slots, app info), and the section it was opened at. */
  view(): Promise<SettingsView>;
  checkForUpdates(): Promise<void>;
  /** Called with the new view after every change, from the window or from outside (the CLI, another process). Returns an unsubscribe. */
  onChanged(listener: (view: SettingsView) => void): () => void;
  /** Called when the app asks an open window to show a section (or start an import there). Returns an unsubscribe. */
  onSection(listener: (request: SectionRequest) => void): () => void;
}

export function createSettingsBridge(ipc: IpcRendererLike): SettingsBridge {
  const op = (channel: string, ...args: unknown[]): Promise<Outcome> => ipc.invoke(channel, ...args) as Promise<Outcome>;
  const subscribe = <T>(channel: string, listener: (value: T) => void): (() => void) => {
    const wrapped = (_e: unknown, value: unknown) => listener(value as T);
    ipc.on(channel, wrapped);
    return () => void ipc.removeListener(channel, wrapped);
  };
  return {
    checkForUpdates: async () => {
      const result = await op(CHANNELS.checkForUpdates);
      if (!result.ok) throw new Error(result.error);
    },
    view: () => ipc.invoke(CHANNELS.view) as Promise<SettingsView>,
    onChanged: (listener) => subscribe<SettingsView>(CHANNELS.changed, listener),
    onSection: (listener) => subscribe<SectionRequest>(CHANNELS.section, listener),
    set: (key: string, value: SettingValue) => op(CHANNELS.set, key, value),
    rebind: (commandId: string, chord: string) => op(CHANNELS.rebind, commandId, chord),
    rebindMany: (pairs: { commandId: string; chord: string }[]) => op(CHANNELS.rebindMany, pairs.map((p) => ({ commandId: p.commandId, chord: p.chord }))),
    reset: (target: string | { commandId: string }) => op(CHANNELS.reset, typeof target === "string" ? target : { commandId: target.commandId }),
    resetSection: (sectionId: string) => op(CHANNELS.resetSection, sectionId),
    resetAll: () => op(CHANNELS.resetAll),
    resetEntry: (entryId: string) => op(CHANNELS.resetEntry, entryId),
    undoBatch: (batchId: string) => op(CHANNELS.undoBatch, batchId),
    exportSettings: () => op(CHANNELS.export),
    importPick: () => ipc.invoke(CHANNELS.importPreview) as Promise<{ fileName: string; preview: ImportPreview } | null>,
    importApply: (_preview: ImportPreview, fileName: string) => op(CHANNELS.importApply, fileName),
    setSecret: (slotId: string, value: string) => op(CHANNELS.setSecret, slotId, value),
    removeSecret: (slotId: string) => op(CHANNELS.removeSecret, slotId),
    choosePath: (key: string) => ipc.invoke(CHANNELS.choosePath, key) as Promise<string | null>,
  };
}
