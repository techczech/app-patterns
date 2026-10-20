/**
 * The parts of Electron this package uses, as structural types. Electron's own objects satisfy them; the tests pass fakes, so nothing
 * here needs the Electron runtime. Only `main.ts` and `preload.ts` import "electron".
 */

export interface FrameLike {
  url: string;
  parent: unknown | null;
}

export interface WebContentsLike {
  readonly mainFrame: unknown;
  send(channel: string, ...args: unknown[]): void;
  isDestroyed(): boolean;
  on(event: "will-navigate" | "will-frame-navigate" | "will-redirect", listener: (e: { preventDefault(): void; url: string; isMainFrame?: boolean }) => void): unknown;
  on(event: "will-attach-webview", listener: (e: { preventDefault(): void }) => void): unknown;
  setWindowOpenHandler(handler: () => { action: "deny" }): void;
}

export interface BrowserWindowLike {
  readonly webContents: WebContentsLike;
  show(): void;
  focus(): void;
  isDestroyed(): boolean;
  loadURL(url: string): Promise<void>;
  on(event: "closed" | "focus", listener: () => void): unknown;
  once(event: "ready-to-show", listener: () => void): unknown;
}

/** The options this package passes when it creates the Settings window (a subset of `BrowserWindowConstructorOptions`). */
export interface SettingsWindowOptions {
  width: number;
  height: number;
  minimizable: false;
  fullscreenable: false;
  titleBarStyle: "hiddenInset";
  title: string;
  show: false;
  webPreferences: {
    preload: string;
    sandbox: true;
    contextIsolation: true;
    nodeIntegration: false;
    nodeIntegrationInSubFrames: false;
    webviewTag: false;
  };
  [extra: string]: unknown;
}

export type BrowserWindowCtor = new (opts: SettingsWindowOptions) => BrowserWindowLike;

export interface IpcMainEventLike {
  sender: unknown;
  senderFrame: FrameLike | null;
}

export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcMainEventLike, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
  /** Listeners added with `ipcMain.on` (Electron's ipcMain is an EventEmitter); used to find an app already listening on a channel. */
  listenerCount?(channel: string): number;
}

export interface DialogLike {
  showSaveDialog(
    win: BrowserWindowLike | undefined,
    opts: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] },
  ): Promise<{ canceled: boolean; filePath?: string }>;
  showOpenDialog(
    win: BrowserWindowLike | undefined,
    opts: { title?: string; defaultPath?: string; properties: ("openFile" | "openDirectory" | "createDirectory")[]; filters?: { name: string; extensions: string[] }[] },
  ): Promise<{ canceled: boolean; filePaths: string[] }>;
}

export interface MenuLike {
  buildFromTemplate(template: unknown[]): unknown;
  setApplicationMenu(menu: unknown): void;
}

export interface AppLike {
  getName(): string;
  getVersion(): string;
  getPath(name: "downloads" | "documents" | "home" | "userData"): string;
}

/** What the installer needs from Electron. `main.ts` passes the real modules. */
export interface ElectronDeps {
  ipcMain: IpcMainLike;
  BrowserWindow: BrowserWindowCtor;
  dialog: DialogLike;
  Menu: MenuLike;
}

/** The slice of Electron's `safeStorage` the key slots need; tests pass a fake. */
export interface Cipher {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

/** The slice of `ipcRenderer` the preload bridge uses. */
export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}
