/**
 * Preload entry for the Settings window. Call `exposeSettingsBridge()` in the window's preload script; the page then finds the bridge at
 * `window.bridleSettings` (or the name given). Bundle the preload with the app (a sandboxed preload cannot load packages itself).
 */
import { contextBridge, ipcRenderer } from "electron";
import { createSettingsBridge, type SettingsBridge } from "./bridge.ts";

export type { SettingsBridge } from "./bridge.ts";
export type { SectionRequest, SettingsView } from "./channels.ts";

export function exposeSettingsBridge(name = "bridleSettings"): SettingsBridge {
  const bridge = createSettingsBridge(ipcRenderer);
  contextBridge.exposeInMainWorld(name, bridge);
  return bridge;
}
