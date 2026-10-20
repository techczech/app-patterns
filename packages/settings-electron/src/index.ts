/** `@app-patterns/settings-electron`: no Electron import here. `./main` adds `installSettings` over Electron; `./preload` adds `exposeSettingsBridge`. */
export { CHANNEL_PREFIX, CHANNELS, type InvokeChannel, type SectionRequest, type SettingsView } from "./channels.ts";
export { installSettingsWith, MESSAGES, SETTINGS_WINDOW_SIZE, type InstallSettingsOptions, type SettingsHost, type SettingsStoreLike } from "./install.ts";
export {
  checkSecret, LAST4_MIN_CHARS, MAX_SECRET_CHARS, MAX_SHAPE_HINT_CHARS, SafeStorageSlots, shapeHintProblem, SLOT_MESSAGES, slotsForWindow,
  type SafeStorageSlotsOptions, type SecretSlots, type SlotDef, type SlotInfo, type SlotResult, type SlotStatus,
} from "./secret-slots.ts";
export { createSettingsBridge, type SettingsBridge } from "./bridge.ts";
export type {
  AppLike, BrowserWindowCtor, BrowserWindowLike, Cipher, DialogLike, ElectronDeps, IpcMainEventLike, IpcMainLike, IpcRendererLike, MenuLike,
  SettingsWindowOptions, WebContentsLike,
} from "./electron-types.ts";
