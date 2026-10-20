/**
 * Main-process entry: `installSettings` and `safeStorageSlots` over the real Electron modules. Everything with behaviour lives in
 * `install.ts` and `secret-slots.ts`, which take Electron as an argument so the tests run without it.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import { BrowserWindow, Menu, app as electronApp, dialog, ipcMain, safeStorage } from "electron";
import type { BrowserWindowCtor, DialogLike, ElectronDeps, IpcMainLike, MenuLike } from "./electron-types.ts";
import { installSettingsWith, type InstallSettingsOptions, type SettingsHost } from "./install.ts";
import { SafeStorageSlots, type SlotDef } from "./secret-slots.ts";

export * from "./index.ts";

const electron = (): ElectronDeps => ({
  ipcMain: ipcMain as unknown as IpcMainLike,
  BrowserWindow: BrowserWindow as unknown as BrowserWindowCtor,
  dialog: dialog as unknown as DialogLike,
  Menu: Menu as unknown as MenuLike,
});

/**
 * Installs the Settings host: `bridle-settings:` IPC, the Settings window, the generated menu, export and import. Wire the store's `onChange`
 * to the returned `storeChanged`. `app` defaults to Electron's.
 */
export function installSettings<G extends string, Ctx>(opts: Omit<InstallSettingsOptions<G, Ctx>, "app"> & { app?: InstallSettingsOptions<G, Ctx>["app"] }): SettingsHost {
  return installSettingsWith(electron(), { ...opts, app: opts.app ?? electronApp });
}

/**
 * Key slots kept in `dir`, encrypted with Electron's safeStorage. Create after the app is ready (safeStorage needs it on macOS).
 * `root` (default: the app's userData folder when `dir` is inside it, else `dir`) is the folder below which no folder may be a link.
 */
export function safeStorageSlots(dir: string, slots: readonly SlotDef[], root?: string): SafeStorageSlots {
  const userData = resolve(electronApp.getPath("userData"));
  const rel = relative(userData, resolve(dir));
  const inside = rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  return new SafeStorageSlots({ dir, slots, cipher: safeStorage, root: root ?? (inside ? userData : dir) });
}
