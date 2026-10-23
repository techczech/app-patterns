/** Fake Electron (ipcMain, BrowserWindow, dialog, Menu, app), a fake Cipher, and a store over a small schema, for the tests. */
import { afterEach } from "bun:test";
import { defineRegistry, type MenuDecl } from "@app-patterns/commands";
import { commandsAdapter, defineSchema, type SettingsState } from "@app-patterns/settings";
import { SettingsStore } from "@app-patterns/settings/node";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppLike, BrowserWindowLike, Cipher, ElectronDeps, IpcMainEventLike, SettingsWindowOptions } from "./electron-types.ts";
import { installSettingsWith, type InstallSettingsOptions, type SettingsHost } from "./install.ts";
import { SafeStorageSlots } from "./secret-slots.ts";

const made: string[] = [];
// bun runs a shared module's afterEach only for the first test file that loads it, so also sweep at process exit.
let exitHooked = false;
function ensureExitCleanup(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", () => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });
}
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

export function tempDir(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "bridle-settings-electron-")));
  made.push(d);
  ensureExitCleanup();
  return d;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export async function until(check: () => boolean, ms: number): Promise<number> {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > ms) throw new Error(`not within ${ms} ms`);
    await sleep(10);
  }
  return Date.now() - t0;
}

// ---- schema and registry ----------------------------------------------------------------------------------------------------------

export const schema = defineSchema({
  app: "testapp",
  sections: [{ id: "editor", label: "Editor", icon: "pen-line" }],
  settings: [
    { key: "appearance.theme", label: "Theme", section: "appearance", type: "choice", default: "light", options: [{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }] },
    { key: "editor.size", label: "Size", section: "editor", type: "number", default: 16, min: 10, max: 32 },
    { key: "editor.focus", label: "Focus", section: "editor", type: "toggle", default: false },
    { key: "general.folder", label: "Folder", section: "general", type: "path", default: "~/Documents" },
    { key: "accounts.openai", label: "OpenAI key", section: "accounts", type: "secret", default: null },
  ],
});

type G = "File" | "Item";
export const registry = defineRegistry<G>([
  { id: "new-item", group: "File", label: "New item", key: "⌘N", icon: "plus" },
  { id: "rename", group: "Item", label: "Rename", key: "⌘R", icon: "pencil" },
]);
export const menus: MenuDecl<G>[] = [{ label: "File", groups: ["File"] }, { label: "Item", groups: ["Item"] }];

export const SETTINGS_URL = "file:///Applications/Test.app/renderer/index.html#settings";

// ---- fake Electron ----------------------------------------------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Listener = (...args: any[]) => void;

export class FakeWebContents {
  readonly mainFrame: { url: string; parent: unknown | null } = { url: "", parent: null };
  readonly sent: { channel: string; args: unknown[] }[] = [];
  readonly listeners = new Map<string, Listener[]>();
  openHandler: (() => { action: "deny" }) | undefined;
  destroyed = false;
  send(channel: string, ...args: unknown[]): void {
    this.sent.push({ channel, args });
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  on(event: string, l: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), l]);
    return this;
  }
  setWindowOpenHandler(h: () => { action: "deny" }): void {
    this.openHandler = h;
  }
  /** Fires a navigation event; true when a listener prevented it. */
  navigate(event: string, url: string, isMainFrame = true): boolean {
    let prevented = false;
    for (const l of this.listeners.get(event) ?? []) l({ url, isMainFrame, preventDefault: () => (prevented = true) });
    return prevented;
  }
}

export class FakeWindow implements BrowserWindowLike {
  readonly webContents = new FakeWebContents();
  shown = 0;
  focused = 0;
  destroyed = false;
  loaded: string[] = [];
  private listeners = new Map<string, (() => void)[]>();
  constructor(readonly options: SettingsWindowOptions) {}
  show(): void {
    this.shown++;
  }
  focus(): void {
    this.focused++;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  loadURL(url: string): Promise<void> {
    this.loaded.push(url);
    this.webContents.mainFrame.url = url;
    return Promise.resolve();
  }
  on(event: "closed" | "focus", l: () => void): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), l]);
    return this;
  }
  /** Fires a window event ("focus", "closed"). */
  emit(event: "closed" | "focus"): void {
    for (const l of this.listeners.get(event) ?? []) l();
  }
  once(_event: "ready-to-show", l: () => void): this {
    l();
    return this;
  }
  close(): void {
    this.destroyed = true;
    this.webContents.destroyed = true;
    this.emit("closed");
  }
}

export interface FakeElectron {
  deps: ElectronDeps;
  windows: FakeWindow[];
  handlers: Map<string, (event: IpcMainEventLike, ...args: unknown[]) => unknown>;
  /** `ipcMain.on` listener counts by channel, as the app would have added them. */
  listeners: Map<string, number>;
  /** The menu templates set, newest last. */
  menus: unknown[][];
  /** Answers for the next save and open panels. */
  saveAnswers: { canceled: boolean; filePath?: string }[];
  openAnswers: { canceled: boolean; filePaths: string[] }[];
  dialogCalls: { kind: "save" | "open"; opts: unknown }[];
}

export function fakeElectron(): FakeElectron {
  const fe: FakeElectron = { windows: [], handlers: new Map(), listeners: new Map(), menus: [], saveAnswers: [], openAnswers: [], dialogCalls: [], deps: undefined as unknown as ElectronDeps };
  class BW extends FakeWindow {
    constructor(opts: SettingsWindowOptions) {
      super(opts);
      fe.windows.push(this);
    }
  }
  fe.deps = {
    ipcMain: {
      handle: (c, l) => {
        // Real Electron's words: "Attempted to register a second handler for '<channel>'".
        if (fe.handlers.has(c)) throw new Error(`Attempted to register a second handler for '${c}'`);
        fe.handlers.set(c, l);
      },
      removeHandler: (c) => void fe.handlers.delete(c),
      listenerCount: (c) => fe.listeners.get(c) ?? 0,
    },
    BrowserWindow: BW,
    dialog: {
      showSaveDialog: async (_w, opts) => {
        fe.dialogCalls.push({ kind: "save", opts });
        return fe.saveAnswers.shift() ?? { canceled: true };
      },
      showOpenDialog: async (_w, opts) => {
        fe.dialogCalls.push({ kind: "open", opts });
        return fe.openAnswers.shift() ?? { canceled: true, filePaths: [] };
      },
    },
    Menu: {
      buildFromTemplate: (t) => t,
      setApplicationMenu: (m) => void fe.menus.push(m as unknown[]),
    },
  };
  return fe;
}

export const fakeApp = (downloads: string): AppLike => ({ getName: () => "TestApp", getVersion: () => "1.2.3", getPath: () => downloads });

/** A reversible cipher with a marker, so plain text is never on disk and damaged bytes fail to decrypt. */
export function fakeCipher(available = true): Cipher & { calls: number } {
  const mask = (b: Buffer) => Buffer.from(b.map((x, i) => x ^ (0x5a + (i % 7))));
  const c = {
    calls: 0,
    isEncryptionAvailable: () => available,
    encryptString: (plain: string) => {
      c.calls++;
      return Buffer.concat([Buffer.from("FAKE1:"), mask(Buffer.from(plain, "utf8"))]);
    },
    decryptString: (enc: Buffer) => {
      c.calls++;
      if (!enc.subarray(0, 6).equals(Buffer.from("FAKE1:"))) throw new Error("bad ciphertext");
      return mask(enc.subarray(6)).toString("utf8");
    },
  };
  return c;
}

// ---- a host over a real store -----------------------------------------------------------------------------------------------------

export interface Harness {
  fe: FakeElectron;
  host: SettingsHost;
  store: SettingsStore;
  slots: SafeStorageSlots;
  dir: string;
  sent: { openMain: number; commands: string[] };
  /** Invokes a channel as the Settings window's top frame would. */
  call(channel: string, ...args: unknown[]): Promise<unknown>;
  /** Invokes a channel with a hand-made event. */
  callAs(event: IpcMainEventLike, channel: string, ...args: unknown[]): Promise<unknown>;
  win(): FakeWindow;
}

export async function harness(more: Partial<InstallSettingsOptions<G, void>> = {}, watch = false, fe = fakeElectron()): Promise<Harness> {
  const dir = tempDir();
  let host: SettingsHost | undefined;
  const store = new SettingsStore({
    dir, app: "testapp", schema, registry: commandsAdapter(registry), appVersion: "1.2.3", watch,
    onChange: (s: SettingsState) => host?.storeChanged(s), log: () => undefined,
  });
  await store.ready;
  closers.push(() => store.close());
  const slots = new SafeStorageSlots({ dir: join(dir, "keys"), slots: [{ id: "accounts.openai", label: "OpenAI key" }], cipher: fakeCipher() });
  const sent = { openMain: 0, commands: [] as string[] };
  host = installSettingsWith(fe.deps, {
    app: fakeApp(dir), store, schema, registry, menus,
    openMain: () => void sent.openMain++, sendCommand: (id) => void sent.commands.push(id),
    window: { preload: "/Applications/Test.app/preload/settings.cjs", url: SETTINGS_URL },
    slots, hostName: "Test Mac", ...more,
  });
  const h: Harness = {
    fe, host, store, slots, dir, sent,
    win: () => {
      const w = fe.windows.at(-1);
      if (!w) throw new Error("no window");
      return w;
    },
    callAs: async (event, channel, ...args) => {
      const fn = fe.handlers.get(channel);
      if (!fn) throw new Error(`no handler for ${channel}`);
      return fn(event, ...args);
    },
    call: async (channel, ...args) => {
      const w = h.win();
      return h.callAs({ sender: w.webContents, senderFrame: w.webContents.mainFrame as { url: string; parent: null } }, channel, ...args);
    },
  };
  return h;
}
