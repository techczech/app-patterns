/**
 * The Electron host for the shared Settings window. `installSettingsWith(electron, options)` registers the `bridle-settings:` IPC handlers over a
 * `SettingsStore`, owns the single Settings window, installs the menu generated from the command registry (and rebuilds it when a
 * shortcut changes), and runs export and import through the native save and open panels.
 *
 * What holds:
 * - Every change goes through the store, so each one logs its changelog entry with who (invariant 3). Keys go to the slots, never the
 *   store; each key saved or removed is logged through `store.recordSecret` as "connected" / "missing", never the value.
 * - Only the Settings window's own page, in its top frame, may call a `bridle-settings:` channel: its URL must equal `window.url` exactly
 *   (query and fragment included). A page that changes its own fragment loses access until it is back on that URL.
 * - Nothing sent to the window carries a key's value: slots leave as status + last four characters (invariant 5). No text an app's
 *   slots return (a detail, an error) is sent or logged: every slot outcome is put in this package's own fixed words,
 *   except a slot's own `shapeHint`, fixed text checked at install, shown only when that slot refuses a value's shape.
 * - The window is told about every change, its own or from outside, as soon as the store reports it (invariant 6): wire the store's
 *   `onChange` to `storeChanged`. Own changes push too, so a missed wiring still shows the window's own edits. Every view is built at
 *   once from the store and a slot cache in main; slot reads run one at a time (at start, on opening and focusing the window, after a
 *   key is saved or removed) and push when they answer. A read not answered within `SLOT_READ_MS` shows every slot as a problem.
 */
import { buildMenuTemplate, type MenuDecl, type MenuInput, type Registry } from "@app-patterns/commands";
import type { ApplyEnv, Schema, SettingsState } from "@app-patterns/settings";
import { MAX_FILE_BYTES, readBoundedFile, type SettingsStore } from "@app-patterns/settings/node";
import type { AppInfo, Outcome, Slot } from "@app-patterns/settings-react";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import { CHANNELS, type SectionRequest, type SettingsView } from "./channels.ts";
import type { AppLike, BrowserWindowLike, ElectronDeps, IpcMainEventLike, SettingsWindowOptions, WebContentsLike } from "./electron-types.ts";
import { isSlotMessage, shapeHintProblem, slotsForWindow, type SecretSlots, type SlotInfo } from "./secret-slots.ts";
import {
  chordArg, commandIdArg, fileNameArg, idArg, pairsArg, pathKeyArg, resetTargetArg, secretValueArg, sectionArg, settingKeyArg, valueArg,
} from "./validate.ts";

/** The store methods the host uses; a `SettingsStore` from `@app-patterns/settings/node` fits. */
export type SettingsStoreLike = Pick<
  SettingsStore,
  "view" | "problem" | "set" | "rebind" | "rebindMany" | "reset" | "resetSection" | "resetAll" | "resetEntry" | "undoBatch" | "previewImport" | "applyImport" | "exportFile" | "recordSecret"
>;

/** How long a slot read may take before every slot is shown as a problem (views never wait for a read, so invariant 6's 1 s holds). */
export const SLOT_READ_MS = 500;

export const SETTINGS_WINDOW_SIZE = { width: 1000, height: 690 } as const;

export const MESSAGES = {
  invalid: "That request could not be understood",
  failed: "That could not be done",
  importAgain: "Choose the file again before importing it",
  unreadable: "The file could not be read",
  tooLarge: "The file is too large to be a settings file",
  secretFailed: "The key could not be saved",
  removeFailed: "The key could not be removed",
  secretUnlogged: "The key was changed, but the change could not be added to the list of changes",
  noSlots: "This app keeps no keys",
} as const;

export interface InstallSettingsOptions<G extends string, Ctx> {
  /** Electron's `app` (for its name, `getVersion()` for About, and the Downloads folder). */
  app: AppLike;
  store: SettingsStoreLike;
  /** The schema the store was opened with: arguments are checked against it. */
  schema: Schema;
  registry: Registry<G, Ctx>;
  menus: MenuDecl<G>[];
  /** Shows the main window (focus it if open). Called before an app command chosen from the menu is sent. */
  openMain(): void;
  /** Runs an app command in the main window (the frame's Settings, Export and Import are handled here). */
  sendCommand(id: string): void;
  /** The Settings window's preload (which calls `exposeSettingsBridge`) and the page it loads. Only that page may call `bridle-settings:`. */
  window: {
    preload: string; url: string; title?: string; extra?: Record<string, unknown>;
    /** Show the window when it is ready (default true). `false` creates it hidden and keeps it hidden, for end-to-end tests. */
    showOnReady?: boolean;
  };
  /** The product name for the App menu, the About card and the export file name (default `app.getName()`, which is the package name in development). */
  appName?: string;
  /** Accounts and keys. Without it the window shows no slots and `setSecret` is refused. */
  slots?: SecretSlots;
  /** The registry's `available?(ctx)` context for the menu; call `rebuildMenu()` when it changes. */
  menuContext?(): Ctx;
  appItems?: MenuInput<G, Ctx>["appItems"];
  /** About-card extras (`build`, `icon`, `cli`). Name and version always come from `app`. */
  appInfo?: Omit<AppInfo, "name" | "version">;
  /** The app supplies its update checker, including Store and busy-mode rules. */
  checkForUpdates?(): void | Promise<void>;
  /** Ids of custom pages the window may be opened at, besides the schema's sections. */
  extraSections?: string[];
  /** For a `path` setting's picker: a file or a folder (default folder). */
  pathKind?(key: string): "file" | "folder";
  /** Passed to `previewImport` (default: `pathExists` over the local disk). */
  applyEnv?: ApplyEnv;
  /** The Mac's name in exports (default `os.hostname()`). */
  hostName?: string;
  now?(): number;
}

export interface SettingsHost {
  /** Opens Settings, at `section` when it names one: an open window is shown, focused and told; there is never a second one. */
  openSettingsWindow(section?: string): BrowserWindowLike;
  settingsWindow(): BrowserWindowLike | null;
  /** Wire the store's `onChange` here. Pushes `changed` to an open window and rebuilds the menu when a shortcut changed. */
  storeChanged(state?: SettingsState): void;
  /** Call when the slots change outside the window (a key rejected by the service, a sign-out elsewhere). */
  slotsChanged(): void;
  rebuildMenu(): void;
  /** Export Settings…: the save panel, then the file. */
  exportSettings(): Promise<Outcome>;
  /** Import Settings…: opens Settings at General with the import asked for, as the menu item does (for a rebound `import-settings`). */
  startImport(): BrowserWindowLike;
  /**
   * True when an IPC call came from the Settings window's top frame showing the Settings page: the rule every `bridle-settings:` handler
   * applies, for the app's own handlers behind custom pages.
   */
  isSettingsWindowSender(event: IpcMainEventLike): boolean;
  /** Removes the handlers. */
  dispose(): void;
}

/** The URL in its normal form (as Electron reports a frame's URL), nothing removed; null when it is not one. */
const pageOf = (url: string): string | null => {
  try {
    return new URL(url).href;
  } catch {
    return null;
  }
};

const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

const outcomeOf = (r: { ok: true; batch?: string } | { ok: false; error: string }): Outcome =>
  r.ok ? (r.batch !== undefined ? { ok: true, batch: r.batch } : { ok: true }) : { ok: false, error: r.error };

/** The error `installSettings` throws when the app already uses one of its channels. */
export const collisionMessage = (channel: string): string =>
  `@app-patterns/settings-electron: channel "${channel}" is already handled by the app; rename the app's channel`;

const fileStamp = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function installSettingsWith<G extends string, Ctx>(electron: ElectronDeps, opts: InstallSettingsOptions<G, Ctx>): SettingsHost {
  const { app, store, schema, registry } = opts;
  const { ipcMain, BrowserWindow, dialog, Menu } = electron;
  const now = opts.now ?? Date.now;
  const base = pageOf(opts.window.url);
  if (base === null) throw new Error("installSettings: window.url is not a URL");
  // Before anything is set up: no channel of ours may already have an app listener, and the two outgoing channels (which this package
  // never handles) may not have an app handler. A taken incoming channel is caught when its handler is registered, below.
  for (const channel of Object.values(CHANNELS)) {
    if ((ipcMain.listenerCount?.(channel) ?? 0) > 0) throw new Error(collisionMessage(channel));
  }
  for (const channel of [CHANNELS.changed, CHANNELS.section]) {
    // Probe: register and remove in the same synchronous step, so no call can reach the probe. Electron throws when one exists.
    try {
      ipcMain.handle(channel, () => undefined);
    } catch {
      throw new Error(collisionMessage(channel));
    }
    ipcMain.removeHandler(channel);
  }
  const isCommand = (id: string) => registry.isCommandId(id);
  const extraSections = opts.extraSections ?? [];
  /** The slots' shape hints, copied and checked once: later changes to the adapter's map are not seen. */
  const shapeHints = new Map<string, string>();
  const declaredHints = opts.slots?.shapeHints;
  if (declaredHints !== undefined) {
    if (!(declaredHints instanceof Map)) throw new Error("installSettings: slots.shapeHints must be a Map");
    // Copied once through Map's own iterator (a subclass's override is not used), then the copy is checked and kept.
    const copy: [unknown, unknown][] = [...Map.prototype.entries.call(declaredHints)];
    for (const [id, hint] of copy) {
      const problem = shapeHintProblem(hint);
      if (typeof id !== "string" || problem) throw new Error(`installSettings: the shapeHint of slot "${String(id)}" ${problem ?? "has no slot id"}`);
      shapeHints.set(id, hint as string);
    }
  }

  let win: BrowserWindowLike | null = null;
  let request: SectionRequest | undefined;
  let lastSent: string | undefined;
  let lastKeys: string | undefined;
  /** The file the window last previewed: `importApply` applies this, never a preview sent back by the renderer. */
  let pending: { fileName: string; preview: ReturnType<SettingsStoreLike["previewImport"]> } | null = null;

  const appName = (): string => opts.appName ?? app.getName();
  const showOnReady = opts.window.showOnReady !== false;

  const current = (): BrowserWindowLike | null => (win && !win.isDestroyed() ? win : null);

  // ---- menu -------------------------------------------------------------------------------------------------------------------------

  const runFromMenu = (id: string): void => {
    if (id === "settings") openWindow();
    else if (id === "export-settings") void exportSettings();
    else if (id === "import-settings") openWindow("general", "import");
    else {
      opts.openMain();
      opts.sendCommand(id);
    }
  };

  const rebuildMenu = (): void => {
    const keys = store.view().keys;
    lastKeys = canon(keys);
    const template = buildMenuTemplate({
      appName: appName(), registry, menus: opts.menus, bindings: registry.bindingsOf(keys), run: runFromMenu,
      ctx: (opts.menuContext ? opts.menuContext() : undefined) as Ctx, ...(opts.appItems ? { appItems: opts.appItems } : {}),
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  };

  // ---- the view and the push --------------------------------------------------------------------------------------------------------

  /**
   * The slot cache: the window's slots as last read, held here so every view is built from it at once, never after a wait. Before the
   * first read answers it holds the schema's `secret` settings, each a problem; a read late by `SLOT_READ_MS` (or failed) marks every
   * slot a problem until a read answers. One read at a time: a refresh asked for while one runs is run once when it settles.
   */
  const schemaSlots = (): Slot[] =>
    schema.settings.filter((d) => d.type === "secret").map((d) => ({ id: d.key, label: d.label, status: "problem" as const }));
  let slotState: Slot[] = opts.slots ? schemaSlots() : [];
  let reading = false;
  let again = false;
  const allProblem = (): void => {
    slotState = slotState.map((s) => ({ id: s.id, label: s.label, status: "problem" }));
  };

  /** Reads the slots once (or marks one more read when one is running); each outcome updates the cache and pushes. */
  const readSlots = (): void => {
    const slots = opts.slots;
    if (!slots) return;
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      allProblem();
      push();
    }, SLOT_READ_MS);
    void Promise.resolve()
      .then(() => slots.list())
      .then((list) => slotsForWindow(list), () => null)
      .then((list) => {
        settled = true;
        clearTimeout(timer);
        if (list) slotState = list;
        else allProblem();
        reading = false;
        push();
        if (again) {
          again = false;
          readSlots();
        }
      });
  };

  /** Built from the store and the slot cache as they are now, with no wait between reading them and sending. */
  const buildView = (): SettingsView => {
    const problem = store.problem();
    return {
      state: store.view(),
      slots: slotState,
      appInfo: { ...opts.appInfo, name: appName(), version: app.getVersion() },
      ...(problem ? { problem: problem.error } : {}),
    };
  };

  /**
   * Pushes the view when it differs from what the window last got (once the window has asked for its first view), and rebuilds the
   * menu when a shortcut changed.
   */
  const push = (): void => {
    if (canon(store.view().keys) !== lastKeys) rebuildMenu();
    const w = current();
    if (!w || w.webContents.isDestroyed() || lastSent === undefined) return;
    const view = buildView();
    const text = canon(view);
    if (text === lastSent) return;
    lastSent = text;
    w.webContents.send(CHANNELS.changed, view);
  };

  // ---- the window -------------------------------------------------------------------------------------------------------------------

  const lockDown = (contents: WebContentsLike): void => {
    const stay = (e: { preventDefault(): void; url: string; isMainFrame?: boolean }) => {
      if (e.isMainFrame === false || pageOf(e.url) !== base) e.preventDefault();
    };
    contents.on("will-navigate", stay);
    contents.on("will-frame-navigate", stay);
    contents.on("will-redirect", stay);
    contents.on("will-attach-webview", (e) => e.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
  };

  const openWindow = (section?: string, action?: "import"): BrowserWindowLike => {
    const target = section !== undefined ? sectionArg(schema, extraSections, section) : null;
    const req: SectionRequest | undefined = target ? { section: target, ...(action ? { action } : {}) } : undefined;
    const open = current();
    if (open) {
      if (showOnReady) {
        open.show();
        open.focus();
      }
      if (req) open.webContents.send(CHANNELS.section, req);
      return open;
    }
    request = req;
    lastSent = undefined;
    const options: SettingsWindowOptions = {
      ...opts.window.extra,
      ...SETTINGS_WINDOW_SIZE,
      title: opts.window.title ?? "Settings",
      show: false,
      minimizable: false,
      fullscreenable: false,
      titleBarStyle: "hiddenInset",
      webPreferences: { preload: opts.window.preload, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false },
    };
    const created = new BrowserWindow(options);
    win = created;
    if (showOnReady) created.once("ready-to-show", () => created.show());
    created.on("focus", () => readSlots());
    created.on("closed", () => {
      if (win === created) {
        win = null;
        pending = null;
        lastSent = undefined;
      }
    });
    lockDown(created.webContents);
    readSlots();
    void created.loadURL(opts.window.url).catch(() => undefined);
    return created;
  };

  /** The call came from the Settings window's contents, its top frame, showing the Settings page. */
  const fromSettingsWindow = (e: IpcMainEventLike): boolean => {
    const w = current();
    if (!w || e.sender !== w.webContents) return false;
    const frame = e.senderFrame;
    return !!frame && frame.parent === null && frame === w.webContents.mainFrame && pageOf(frame.url) === base;
  };

  // ---- export and import ------------------------------------------------------------------------------------------------------------

  async function exportSettings(): Promise<Outcome> {
    const w = current() ?? undefined;
    const r = await dialog.showSaveDialog(w, {
      title: "Export Settings",
      defaultPath: join(app.getPath("downloads"), `${appName()} settings ${fileStamp(now())}.json`),
      filters: [{ name: "Settings", extensions: ["json"] }],
    });
    if (r.canceled || !r.filePath) return { ok: true };
    const file = store.exportFile({ hostName: opts.hostName ?? hostname() });
    try {
      await writeFile(r.filePath, JSON.stringify(file, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
      return { ok: true };
    } catch {
      return { ok: false, error: "The settings file could not be written there" };
    }
  }

  const importPreview = async (): Promise<{ fileName: string; preview: ReturnType<SettingsStoreLike["previewImport"]> } | null> => {
    const r = await dialog.showOpenDialog(current() ?? undefined, {
      title: "Import Settings", properties: ["openFile"], filters: [{ name: "Settings", extensions: ["json"] }],
    });
    const path = r.canceled ? undefined : r.filePaths[0];
    if (!path) return null;
    const read = await readBoundedFile(path, MAX_FILE_BYTES);
    if (read.kind === "too-large") throw new Error(MESSAGES.tooLarge);
    if (read.kind !== "ok") throw new Error(MESSAGES.unreadable);
    const preview = store.previewImport(read.text, opts.applyEnv ?? { pathExists: (p: string) => existsSync(p) });
    const fileName = basename(path);
    pending = { fileName, preview };
    return { fileName, preview };
  };

  // ---- IPC --------------------------------------------------------------------------------------------------------------------------

  const registered: string[] = [];
  /** A handler that only the Settings window may call; a refused caller gets an error, never a result. */
  /**
   * Registers one handler. A channel the app already handles (Electron throws "second handler") or listens on stops the install: the
   * handlers this call registered so far are removed and the error names the channel. Nothing else has been set up by then.
   */
  const handle = (channel: string, fn: (...args: unknown[]) => unknown): void => {
    const listening = (ipcMain.listenerCount?.(channel) ?? 0) > 0;
    try {
      if (listening) throw new Error("listener");
      ipcMain.handle(channel, async (event, ...args) => {
        if (!fromSettingsWindow(event)) throw new Error("bridle-settings: not allowed from this window");
        return fn(...args);
      });
    } catch {
      for (const c of registered) ipcMain.removeHandler(c);
      registered.length = 0;
      throw new Error(collisionMessage(channel));
    }
    registered.push(channel);
  };
  /** A handler returning an `Outcome`: bad arguments and failures come back as `{ ok: false }` in fixed words. */
  const handleOp = (channel: string, arity: number, fn: (...args: unknown[]) => Promise<Outcome | null> | Outcome | null): void => {
    handle(channel, async (...args) => {
      if (args.length > arity) return { ok: false, error: MESSAGES.invalid };
      let r: Outcome | null;
      try {
        r = await fn(...args);
      } catch {
        return { ok: false, error: MESSAGES.failed };
      }
      if (r === null) return { ok: false, error: MESSAGES.invalid };
      push();
      return r;
    });
  };

  handle(CHANNELS.view, () => {
    const view = buildView();
    const req = request;
    request = undefined; // delivered once: a reload does not start the import again
    lastSent = canon(view);
    return req ? { ...view, request: req } : view;
  });

  handleOp(CHANNELS.set, 2, async (k, v) => {
    const key = settingKeyArg(schema, k);
    const value = valueArg(v);
    return key === null || value === null ? null : outcomeOf(await store.set(key, value));
  });
  handleOp(CHANNELS.rebind, 2, async (c, ch) => {
    const id = commandIdArg(isCommand, c);
    const chord = chordArg(ch);
    return id === null || chord === null ? null : outcomeOf(await store.rebind(id, chord));
  });
  handleOp(CHANNELS.rebindMany, 1, async (p) => {
    const pairs = pairsArg(isCommand, p);
    return pairs === null ? null : outcomeOf(await store.rebindMany(pairs));
  });
  handleOp(CHANNELS.reset, 1, async (t) => {
    const target = resetTargetArg(schema, isCommand, t);
    return target === null ? null : outcomeOf(await store.reset(target));
  });
  handleOp(CHANNELS.resetSection, 1, async (s) => {
    const section = sectionArg(schema, [], s);
    return section === null ? null : outcomeOf(await store.resetSection(section));
  });
  handleOp(CHANNELS.resetAll, 0, async () => outcomeOf(await store.resetAll()));
  handleOp(CHANNELS.resetEntry, 1, async (e) => {
    const id = idArg(e);
    return id === null ? null : outcomeOf(await store.resetEntry(id));
  });
  handleOp(CHANNELS.undoBatch, 1, async (b) => {
    const id = idArg(b);
    return id === null ? null : outcomeOf(await store.undoBatch(id));
  });
  handleOp(CHANNELS.checkForUpdates, 0, async () => {
    if (!opts.checkForUpdates) return { ok: false, error: MESSAGES.failed };
    await opts.checkForUpdates();
    return { ok: true };
  });
  handleOp(CHANNELS.export, 0, () => exportSettings());
  handle(CHANNELS.importPreview, async (...args) => {
    if (args.length > 0) throw new Error(MESSAGES.invalid);
    return importPreview();
  });
  handleOp(CHANNELS.importApply, 1, async (f) => {
    const fileName = fileNameArg(f);
    if (fileName === null) return null;
    const p = pending;
    if (!p || p.fileName !== fileName || p.preview.refused) return { ok: false, error: MESSAGES.importAgain };
    pending = null;
    return outcomeOf(await store.applyImport(p.preview, { file: fileName }));
  });
  /** The slot's status word before a change, from the slot cache (a problem counts as missing); null when the slot is not known. */
  const statusOf = (id: string): "connected" | "missing" | null => {
    const slot = slotState.find((x) => x.id === id);
    return slot ? (slot.status === "connected" ? "connected" : "missing") : null;
  };
  /**
   * A slot's failure in fixed words: one of `SLOT_MESSAGES` as it is; on a save, a result marked `refusal: "shape"` whose error is the
   * saved slot's own `shapeHint` (copied and checked once, at install) as it is; anything else (an app's own text, another slot's hint,
   * the hint's words without the marker) as `fallback`. Each field of the result is read once.
   */
  const slotError = (r: unknown, fallback: string, hintOf?: string): string => {
    const o = r && typeof r === "object" ? (r as { error?: unknown; refusal?: unknown }) : undefined;
    const error = o?.error;
    if (isSlotMessage(error)) return error;
    const refusal = o?.refusal;
    if (hintOf !== undefined && refusal === "shape" && typeof error === "string" && shapeHints.get(hintOf) === error) return error;
    return fallback;
  };
  /** The change in the changelog (invariant 3), with status words only; a key that is a schema `secret` setting. */
  const logSecret = async (id: string, from: "connected" | "missing", to: "connected" | "missing"): Promise<Outcome> => {
    if (schema.def(id)?.type !== "secret") return { ok: true }; // a sign-in that is not a setting has no row to log against
    try {
      const r = await store.recordSecret(id, from, to);
      return r.ok ? { ok: true } : { ok: false, error: MESSAGES.secretUnlogged };
    } catch {
      return { ok: false, error: MESSAGES.secretUnlogged };
    }
  };
  handleOp(CHANNELS.setSecret, 2, async (s, v) => {
    const slots = opts.slots;
    if (!slots) return { ok: false, error: MESSAGES.noSlots };
    const id = idArg(s);
    const value = secretValueArg(v);
    if (id === null || value === null) return null;
    const from = statusOf(id);
    if (from === null) return null;
    let r: unknown;
    try {
      r = await slots.set(id, value);
    } catch {
      return { ok: false, error: MESSAGES.secretFailed };
    }
    readSlots();
    if (!r || typeof r !== "object" || (r as { ok?: unknown }).ok !== true) return { ok: false, error: slotError(r, MESSAGES.secretFailed, id) };
    return logSecret(id, from, "connected");
  });
  handleOp(CHANNELS.removeSecret, 1, async (s) => {
    const slots = opts.slots;
    if (!slots) return { ok: false, error: MESSAGES.noSlots };
    const id = idArg(s);
    if (id === null) return null;
    const from = statusOf(id);
    if (from === null) return null;
    let r: unknown;
    try {
      r = await slots.remove(id);
    } catch {
      return { ok: false, error: MESSAGES.removeFailed };
    }
    readSlots();
    if (!r || typeof r !== "object" || (r as { ok?: unknown }).ok !== true) return { ok: false, error: slotError(r, MESSAGES.removeFailed) };
    return logSecret(id, from, "missing");
  });
  handle(CHANNELS.choosePath, async (...args) => {
    const key = args.length === 1 ? pathKeyArg(schema, args[0]) : null;
    if (key === null) throw new Error(MESSAGES.invalid);
    const kind = opts.pathKind?.(key) ?? "folder";
    const r = await dialog.showOpenDialog(current() ?? undefined, {
      title: schema.def(key)?.label ?? "Choose", properties: kind === "file" ? ["openFile"] : ["openDirectory", "createDirectory"],
    });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });

  rebuildMenu();
  readSlots();

  return {
    openSettingsWindow: (section?: string) => openWindow(section),
    settingsWindow: current,
    storeChanged: () => push(),
    slotsChanged: () => readSlots(),
    rebuildMenu,
    exportSettings,
    startImport: () => openWindow("general", "import"),
    isSettingsWindowSender: (event: IpcMainEventLike) => fromSettingsWindow(event),
    dispose: () => {
      for (const c of registered) ipcMain.removeHandler(c);
      registered.length = 0;
    },
  };
}
