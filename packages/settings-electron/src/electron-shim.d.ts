/** The Electron exports this package imports, for type-checking without Electron installed (the app supplies the real module). */
declare module "electron" {
  export const ipcMain: unknown;
  export const BrowserWindow: unknown;
  export const dialog: unknown;
  export const Menu: unknown;
  export const app: import("./electron-types.ts").AppLike;
  export const safeStorage: import("./electron-types.ts").Cipher;
  export const ipcRenderer: import("./electron-types.ts").IpcRendererLike;
  export const contextBridge: { exposeInMainWorld(name: string, api: unknown): void };
}
