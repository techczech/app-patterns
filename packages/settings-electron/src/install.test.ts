import { describe, expect, test } from "bun:test";
import type { ImportPreview, SettingsState } from "@app-patterns/settings";
import { commandsAdapter } from "@app-patterns/settings";
import { SettingsStore } from "@app-patterns/settings/node";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHANNEL_PREFIX, CHANNELS, type SettingsView } from "./channels.ts";
import { fakeElectron, harness, registry, schema, SETTINGS_URL, until } from "./fake-electron.test-support.ts";
import { collisionMessage, MESSAGES } from "./install.ts";
import type { SlotInfo } from "./secret-slots.ts";

type MenuNode = { label?: string; accelerator?: string; click?: () => void; submenu?: MenuNode[] };
const findItem = (template: unknown[], label: string): MenuNode | undefined => {
  const walk = (items: MenuNode[]): MenuNode | undefined => {
    for (const i of items) {
      if (i.label === label && i.click) return i;
      const inner = i.submenu ? walk(i.submenu) : undefined;
      if (inner) return inner;
    }
    return undefined;
  };
  return walk(template as MenuNode[]);
};
const invalid = { ok: false, error: MESSAGES.invalid };

describe("the Settings window", () => {
  test("is created once, at 1000×690, not minimizable or full-screen, hidden inset title bar, locked-down web preferences", async () => {
    const h = await harness();
    const w = h.host.openSettingsWindow();
    expect(h.fe.windows).toHaveLength(1);
    expect(w.isDestroyed()).toBe(false);
    const o = h.win().options;
    expect(o).toMatchObject({ width: 1000, height: 690, minimizable: false, fullscreenable: false, titleBarStyle: "hiddenInset", show: false });
    expect(o.webPreferences).toEqual({
      preload: "/Applications/Test.app/preload/settings.cjs", sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false,
    });
    expect(h.win().loaded).toEqual([SETTINGS_URL]);
    expect(h.win().shown).toBe(1);
  });

  test("showOnReady: false keeps the window hidden, also when it is opened again", async () => {
    const h = await harness({ window: { preload: "/p.cjs", url: SETTINGS_URL, showOnReady: false } });
    h.host.openSettingsWindow();
    h.host.openSettingsWindow("editor");
    expect(h.fe.windows).toHaveLength(1);
    expect(h.win().options.show).toBe(false);
    expect(h.win().shown).toBe(0);
    expect(h.win().focused).toBe(0);
    expect(h.win().webContents.sent).toContainEqual({ channel: CHANNELS.section, args: [{ section: "editor" }] });
  });

  test("a second open focuses the open window and tells it the section; no second window", async () => {
    const h = await harness();
    h.host.openSettingsWindow();
    h.host.openSettingsWindow("editor");
    expect(h.fe.windows).toHaveLength(1);
    expect(h.win().focused).toBe(1);
    expect(h.win().webContents.sent).toContainEqual({ channel: CHANNELS.section, args: [{ section: "editor" }] });
    h.host.openSettingsWindow("no-such-section");
    expect(h.win().webContents.sent.filter((s) => s.channel === CHANNELS.section)).toHaveLength(1);
  });

  test("a new window gets its section in the first view, once", async () => {
    const h = await harness();
    h.host.openSettingsWindow("shortcuts");
    const first = (await h.call(CHANNELS.view)) as SettingsView;
    expect(first.request).toEqual({ section: "shortcuts" });
    expect(first.appInfo).toMatchObject({ name: "TestApp", version: "1.2.3" });
    expect(((await h.call(CHANNELS.view)) as SettingsView).request).toBeUndefined();
  });

  test("closing it lets the next open create a fresh one", async () => {
    const h = await harness();
    h.host.openSettingsWindow();
    h.win().close();
    expect(h.host.settingsWindow()).toBeNull();
    h.host.openSettingsWindow();
    expect(h.fe.windows).toHaveLength(2);
  });

  test("never navigates away, never opens a window, never attaches a webview", async () => {
    const h = await harness();
    h.host.openSettingsWindow();
    const wc = h.win().webContents;
    expect(wc.navigate("will-navigate", "https://evil.example/")).toBe(true);
    expect(wc.navigate("will-redirect", "https://evil.example/")).toBe(true);
    expect(wc.navigate("will-frame-navigate", SETTINGS_URL, false)).toBe(true);
    expect(wc.navigate("will-navigate", SETTINGS_URL)).toBe(false);
    expect(wc.openHandler?.()).toEqual({ action: "deny" });
    expect(wc.navigate("will-attach-webview", "")).toBe(true);
  });
});

describe("who may call bridle-settings:", () => {
  test("only the Settings window's top frame on its own page", async () => {
    const h = await harness();
    h.host.openSettingsWindow();
    const wc = h.win().webContents;
    const other = { mainFrame: { url: SETTINGS_URL, parent: null } };
    await expect(h.callAs({ sender: other, senderFrame: other.mainFrame }, CHANNELS.view)).rejects.toThrow("not allowed");
    await expect(h.callAs({ sender: wc, senderFrame: { url: SETTINGS_URL, parent: wc.mainFrame } }, CHANNELS.view)).rejects.toThrow("not allowed");
    await expect(h.callAs({ sender: wc, senderFrame: null }, CHANNELS.view)).rejects.toThrow("not allowed");
    wc.mainFrame.url = "https://evil.example/";
    await expect(h.callAs({ sender: wc, senderFrame: wc.mainFrame }, CHANNELS.set, "editor.focus", true)).rejects.toThrow("not allowed");
    expect(h.store.view().settings).toEqual({});
  });

  test("isSettingsWindowSender applies the same rule to an app's own handlers", async () => {
    const h = await harness();
    const early = { sender: {}, senderFrame: { url: SETTINGS_URL, parent: null } };
    expect(h.host.isSettingsWindowSender(early)).toBe(false);
    h.host.openSettingsWindow();
    const wc = h.win().webContents;
    expect(h.host.isSettingsWindowSender({ sender: wc, senderFrame: wc.mainFrame })).toBe(true);
    const other = { mainFrame: { url: SETTINGS_URL, parent: null } };
    expect(h.host.isSettingsWindowSender({ sender: other, senderFrame: other.mainFrame })).toBe(false);
    expect(h.host.isSettingsWindowSender({ sender: wc, senderFrame: { url: SETTINGS_URL, parent: wc.mainFrame } })).toBe(false);
    expect(h.host.isSettingsWindowSender({ sender: wc, senderFrame: null })).toBe(false);
    wc.mainFrame.url = "https://evil.example/";
    expect(h.host.isSettingsWindowSender({ sender: wc, senderFrame: wc.mainFrame })).toBe(false);
  });

  test("nothing answers while no Settings window is open", async () => {
    const h = await harness();
    const event = { sender: {}, senderFrame: { url: SETTINGS_URL, parent: null } };
    await expect(h.callAs(event, CHANNELS.view)).rejects.toThrow("not allowed");
  });

  test("dispose removes every handler", async () => {
    const h = await harness();
    expect(h.fe.handlers.size).toBeGreaterThan(10);
    expect([...h.fe.handlers.keys()].every((c) => c.startsWith("bridle-settings:"))).toBe(true);
    h.host.dispose();
    expect(h.fe.handlers.size).toBe(0);
  });
});

describe("channel names", () => {
  test("every channel is under the reserved bridle-settings: prefix", () => {
    expect(CHANNEL_PREFIX).toBe("bridle-settings:");
    for (const c of Object.values(CHANNELS)) expect(c).toMatch(/^bridle-settings:[A-Za-z]+$/);
    expect(CHANNELS.set).toBe("bridle-settings:set");
  });

  test("an app's own settings:set handler does not clash, and gets no access through the Settings rule", async () => {
    const fe = fakeElectron();
    const appHandler = () => "app";
    fe.deps.ipcMain.handle("settings:set", appHandler);
    const h = await harness({}, false, fe);
    expect(fe.handlers.get("settings:set")).toBe(appHandler);
    expect(fe.handlers.has(CHANNELS.set)).toBe(true);
    h.host.dispose();
    expect([...fe.handlers.keys()]).toEqual(["settings:set"]);
  });

  test("a channel the app already handles stops the install, names the channel and leaves no handler of ours", async () => {
    const fe = fakeElectron();
    const appHandler = () => "app";
    fe.deps.ipcMain.handle(CHANNELS.importApply, appHandler);
    await expect(harness({}, false, fe)).rejects.toThrow(
      `@app-patterns/settings-electron: channel "${CHANNELS.importApply}" is already handled by the app; rename the app's channel`,
    );
    expect([...fe.handlers.keys()]).toEqual([CHANNELS.importApply]);
    expect(fe.handlers.get(CHANNELS.importApply)).toBe(appHandler);
    expect(fe.menus).toEqual([]);
  });

  for (const name of ["changed", "section"] as const) {
    for (const how of ["handle", "on"] as const) {
      test(`an app ${how} on the outgoing ${name} channel stops the install before anything is set up`, async () => {
        const fe = fakeElectron();
        const channel = CHANNELS[name];
        const appHandler = () => "app";
        if (how === "handle") fe.deps.ipcMain.handle(channel, appHandler);
        else fe.listeners.set(channel, 1);
        await expect(harness({}, false, fe)).rejects.toThrow(collisionMessage(channel));
        expect([...fe.handlers.keys()]).toEqual(how === "handle" ? [channel] : []);
        if (how === "handle") expect(fe.handlers.get(channel)).toBe(appHandler);
        expect(fe.menus).toEqual([]);
        expect(fe.windows).toEqual([]);
      });
    }
  }

  test("the probe of the outgoing channels leaves no handler on them", async () => {
    const h = await harness();
    expect(h.fe.handlers.has(CHANNELS.changed)).toBe(false);
    expect(h.fe.handlers.has(CHANNELS.section)).toBe(false);
  });

  test("a channel the app listens on with ipcMain.on stops the install the same way", async () => {
    const fe = fakeElectron();
    fe.listeners.set(CHANNELS.view, 1);
    await expect(harness({}, false, fe)).rejects.toThrow(collisionMessage(CHANNELS.view));
    expect(fe.handlers.size).toBe(0);
  });
});

describe("changes go through the store with who", () => {
  test("set: one entry by you; bad arguments refused before the store", async () => {
    const h = await harness();
    h.host.openSettingsWindow();
    expect(await h.call(CHANNELS.set, "editor.focus", true)).toEqual({ ok: true });
    expect(h.store.view().settings).toEqual({ "editor.focus": true });
    expect(h.store.view().changes[0]).toMatchObject({ key: "editor.focus", from: false, to: true, who: { kind: "you" } });
    const before = h.store.view().changes.length;
    for (const args of [
      ["no.such", true], ["accounts.openai", "sk-whatever"], ["editor.size", { n: 1 }], ["editor.size", Number.NaN], [42, 1],
      ["editor.size", 12, "extra"], ["x".repeat(300), 1], ["editor.size", "y".repeat(5000)],
    ]) expect(await h.call(CHANNELS.set, ...args)).toEqual(invalid);
    expect(h.store.view().changes.length).toBe(before);
    const r = (await h.call(CHANNELS.set, "editor.size", 99)) as { ok: boolean };
    expect(r.ok).toBe(false); // out of range: the store's words
  });

  test("rebind rebuilds the menu with the new accelerator; unknown commands and odd chords refused", async () => {
    const h = await harness();
    h.host.openSettingsWindow();
    const menusBefore = h.fe.menus.length;
    expect(findItem(h.fe.menus.at(-1)!, "Rename")?.accelerator).toBe("Cmd+R");
    expect(await h.call(CHANNELS.rebind, "rename", "⌘E")).toEqual({ ok: true });
    expect(h.fe.menus.length).toBeGreaterThan(menusBefore);
    expect(findItem(h.fe.menus.at(-1)!, "Rename")?.accelerator).toBe("Cmd+E");
    expect(h.store.view().changes[0]).toMatchObject({ commandId: "rename", to: "⌘E", who: { kind: "you" } });
    expect(await h.call(CHANNELS.rebind, "nope", "⌘E")).toEqual(invalid);
    expect(await h.call(CHANNELS.rebind, "rename", "⌘\u0000")).toEqual(invalid);
    expect(await h.call(CHANNELS.rebindMany, [{ commandId: "rename", chord: "⌘G", extra: 1 }])).toEqual(invalid);
    expect(await h.call(CHANNELS.rebindMany, [{ commandId: "rename", chord: "⌘G" }, { commandId: "new-item", chord: "⌘J" }])).toMatchObject({ ok: true });
    expect(h.store.view().keys).toEqual({ rename: "⌘G", "new-item": "⌘J" });
  });

  test("reset, resetSection, resetAll, resetEntry and undoBatch", async () => {
    const h = await harness();
    h.host.openSettingsWindow();
    await h.call(CHANNELS.set, "editor.size", 20);
    await h.call(CHANNELS.set, "editor.focus", true);
    await h.call(CHANNELS.rebind, "rename", "⌘E");
    expect(await h.call(CHANNELS.reset, { commandId: "rename" })).toEqual({ ok: true });
    expect(h.store.view().keys).toEqual({});
    expect(await h.call(CHANNELS.reset, { commandId: "rename", more: 1 })).toEqual(invalid);
    expect(await h.call(CHANNELS.reset, "accounts.openai")).toEqual(invalid);
    expect(await h.call(CHANNELS.reset, "editor.size")).toEqual({ ok: true });
    const entry = h.store.view().changes.find((c) => c.key === "editor.focus")!;
    expect(await h.call(CHANNELS.resetEntry, entry.id)).toMatchObject({ ok: true });
    expect(h.store.view().settings).toEqual({});
    await h.call(CHANNELS.set, "editor.size", 20);
    expect(await h.call(CHANNELS.resetSection, "nope")).toEqual(invalid);
    expect(await h.call(CHANNELS.resetSection, "editor")).toMatchObject({ ok: true });
    await h.call(CHANNELS.set, "appearance.theme", "dark");
    const all = (await h.call(CHANNELS.resetAll)) as { ok: true; batch?: string };
    expect(all.ok).toBe(true);
    expect(h.store.view().settings).toEqual({});
    expect(await h.call(CHANNELS.resetAll, "extra")).toEqual(invalid);
    expect(await h.call(CHANNELS.undoBatch, 7)).toEqual(invalid);
    expect(((await h.call(CHANNELS.undoBatch, "no-such-batch")) as { ok: boolean }).ok).toBe(false);
    for (const e of h.store.view().changes) expect(e.who.kind === "you" || (e.who.kind === "reset" && e.who.by?.kind === "you")).toBe(true);
  });
});

describe("export and import through the native panels", () => {
  test("export writes the export file where the panel says; cancel does nothing", async () => {
    const h = await harness();
    h.host.openSettingsWindow();
    await h.call(CHANNELS.set, "editor.size", 20);
    const out = join(h.dir, "exported.json");
    h.fe.saveAnswers.push({ canceled: false, filePath: out });
    expect(await h.call(CHANNELS.export)).toEqual({ ok: true });
    const file = JSON.parse(readFileSync(out, "utf8"));
    expect(file).toMatchObject({ format: "bridle-settings-export", app: "testapp", appVersion: "1.2.3", exportedFrom: "Test Mac", settings: { "editor.size": 20 } });
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(await h.call(CHANNELS.export)).toEqual({ ok: true }); // cancelled
    expect((h.fe.dialogCalls[0]!.opts as { defaultPath: string }).defaultPath).toStartWith(join(h.dir, "TestApp settings "));
  });

  test("import: preview from the picked file, apply uses main's own preview (a forged one is ignored), one batch by import", async () => {
    const h = await harness();
    h.host.openSettingsWindow();
    const path = join(h.dir, "from-other-mac.json");
    writeFileSync(path, JSON.stringify({ format: "bridle-settings-export", version: 1, app: "testapp", settings: { "editor.size": 24, "editor.focus": true }, keys: {} }));
    h.fe.openAnswers.push({ canceled: false, filePaths: [path] });
    const picked = (await h.call(CHANNELS.importPreview)) as { fileName: string; preview: ImportPreview };
    expect(picked.fileName).toBe("from-other-mac.json");
    expect(picked.preview.changes.map((c) => c.key).sort()).toEqual(["editor.focus", "editor.size"]);
    expect(await h.call(CHANNELS.importApply, "other.json")).toEqual({ ok: false, error: MESSAGES.importAgain });
    // A renderer cannot hand back a preview: the channel takes the file name only.
    const forged = { changes: [{ key: "editor.size", from: 16, to: 31, section: "editor" }], skipped: [], alreadyMatch: 0 };
    expect(await h.call(CHANNELS.importApply, forged, "from-other-mac.json")).toEqual(invalid);
    const r = (await h.call(CHANNELS.importApply, "from-other-mac.json")) as { ok: true; batch: string };
    expect(r.ok).toBe(true);
    expect(h.store.view().settings).toEqual({ "editor.size": 24, "editor.focus": true });
    const batch = h.store.view().changes.filter((c) => c.batch === r.batch);
    expect(batch).toHaveLength(2);
    for (const e of batch) expect(e.who).toEqual({ kind: "import", file: "from-other-mac.json" });
    expect(await h.call(CHANNELS.importApply, "from-other-mac.json")).toEqual({ ok: false, error: MESSAGES.importAgain }); // used once
    expect(await h.call(CHANNELS.undoBatch, r.batch)).toMatchObject({ ok: true });
    expect(h.store.view().settings).toEqual({});
  });

  test("import: cancel is null; an unreadable or wrong file is said in words", async () => {
    const h = await harness();
    h.host.openSettingsWindow();
    expect(await h.call(CHANNELS.importPreview)).toBeNull();
    h.fe.openAnswers.push({ canceled: false, filePaths: [join(h.dir, "missing.json")] });
    await expect(h.call(CHANNELS.importPreview)).rejects.toThrow(MESSAGES.unreadable);
    const other = join(h.dir, "other.json");
    writeFileSync(other, JSON.stringify({ format: "bridle-settings-export", version: 1, app: "someoneelse", settings: {}, keys: {} }));
    h.fe.openAnswers.push({ canceled: false, filePaths: [other] });
    const picked = (await h.call(CHANNELS.importPreview)) as { preview: ImportPreview };
    expect(picked.preview.refused).toBeDefined();
    expect(await h.call(CHANNELS.importApply, "other.json")).toEqual({ ok: false, error: MESSAGES.importAgain });
  });

  test("choosePath only for path settings, folder picker by default", async () => {
    const h = await harness();
    h.host.openSettingsWindow();
    await expect(h.call(CHANNELS.choosePath, "editor.size")).rejects.toThrow();
    h.fe.openAnswers.push({ canceled: false, filePaths: ["/example/Writing"] });
    expect(await h.call(CHANNELS.choosePath, "general.folder")).toBe("/example/Writing");
    expect((h.fe.dialogCalls.at(-1)!.opts as { properties: string[] }).properties).toEqual(["openDirectory", "createDirectory"]);
  });
});

describe("the product name", () => {
  test("appName replaces app.getName() in the App menu, the About card and the export file name", async () => {
    const h = await harness({ appName: "SlideWell" });
    expect((h.fe.menus[0] as { label?: string }[])[0]!.label).toBe("SlideWell");
    h.host.openSettingsWindow();
    expect(((await h.call(CHANNELS.view)) as SettingsView).appInfo.name).toBe("SlideWell");
    await h.host.exportSettings();
    expect((h.fe.dialogCalls[0]!.opts as { defaultPath: string }).defaultPath).toStartWith(join(h.dir, "SlideWell settings "));
  });
  test("without it the menu says app.getName()", async () => {
    const h = await harness();
    expect((h.fe.menus[0] as { label?: string }[])[0]!.label).toBe("TestApp");
  });
});

describe("the menu", () => {
  test("installed at start; Settings…, Import Settings… and app commands run where they belong", async () => {
    const h = await harness();
    expect(h.fe.menus).toHaveLength(1);
    const t = h.fe.menus[0]!;
    findItem(t, "Settings…")!.click!();
    expect(h.fe.windows).toHaveLength(1);
    findItem(t, "Import Settings…")!.click!();
    expect(h.fe.windows).toHaveLength(1);
    expect(h.win().webContents.sent).toContainEqual({ channel: CHANNELS.section, args: [{ section: "general", action: "import" }] });
    findItem(t, "New item")!.click!();
    expect(h.sent).toEqual({ openMain: 1, commands: ["new-item"] });
  });

  test("startImport() does what Import Settings… does, so a rebound import-settings imports from any route", async () => {
    const closed = await harness();
    closed.host.startImport();
    expect(closed.fe.windows).toHaveLength(1);
    expect(((await closed.call(CHANNELS.view)) as SettingsView).request).toEqual({ section: "general", action: "import" });
    const open = await harness();
    open.host.openSettingsWindow();
    open.host.startImport();
    expect(open.fe.windows).toHaveLength(1);
    expect(open.win().webContents.sent).toContainEqual({ channel: CHANNELS.section, args: [{ section: "general", action: "import" }] });
  });

  test("Import Settings… on a closed window opens it with the import waiting in the first view", async () => {
    const h = await harness();
    findItem(h.fe.menus[0]!, "Import Settings…")!.click!();
    expect(((await h.call(CHANNELS.view)) as SettingsView).request).toEqual({ section: "general", action: "import" });
  });
});

describe("invariant 6: an open window sees an outside change within 1 s", () => {
  test("an agent's write from another store is pushed as changed", async () => {
    const h = await harness({}, true);
    h.host.openSettingsWindow();
    await h.call(CHANNELS.view);
    const agent = new SettingsStore({
      dir: h.dir, app: "testapp", schema, registry: commandsAdapter(registry), appVersion: "1.2.3", watch: false, who: { kind: "agent", name: "claude" }, log: () => undefined,
    });
    await agent.ready;
    const t0 = Date.now();
    expect((await agent.set("editor.size", 22)).ok).toBe(true);
    const pushed = () => h.win().webContents.sent.filter((s) => s.channel === CHANNELS.changed).map((s) => (s.args[0] as SettingsView).state as SettingsState);
    await until(() => pushed().some((s) => s.settings["editor.size"] === 22), 1000);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(pushed().at(-1)!.changes[0]).toMatchObject({ key: "editor.size", who: { kind: "agent", name: "claude" } });
    await agent.close();
  });

  test("an outside shortcut change rebuilds the menu too", async () => {
    const h = await harness({}, true);
    const agent = new SettingsStore({ dir: h.dir, app: "testapp", schema, registry: commandsAdapter(registry), appVersion: "1.2.3", watch: false, log: () => undefined });
    await agent.ready;
    await agent.rebind("rename", "⌘E");
    await until(() => findItem(h.fe.menus.at(-1)!, "Rename")?.accelerator === "Cmd+E", 1000);
    await agent.close();
  });

  test("the window's own change is pushed once, not twice", async () => {
    const h = await harness();
    h.host.openSettingsWindow();
    await new Promise((r) => setTimeout(r, 10)); // the slot read on opening has answered
    await h.call(CHANNELS.view);
    await h.call(CHANNELS.set, "editor.focus", true);
    await until(() => h.win().webContents.sent.some((s) => s.channel === CHANNELS.changed), 500);
    await new Promise((r) => setTimeout(r, 50));
    expect(h.win().webContents.sent.filter((s) => s.channel === CHANNELS.changed)).toHaveLength(1);
  });
});

describe("the page boundary is the configured URL, exactly", () => {
  const BASE = "file:///Applications/Test.app/renderer/index.html";
  test("another query or fragment on the same file has no authority and cannot be navigated to", async () => {
    const h = await harness();
    h.host.openSettingsWindow();
    const wc = h.win().webContents;
    for (const url of [`${BASE}?untrusted=true#main`, `${BASE}#main`, `${BASE}?x=1#settings`, BASE, `${BASE}#settings/about`]) {
      wc.mainFrame.url = url;
      await expect(h.callAs({ sender: wc, senderFrame: wc.mainFrame }, CHANNELS.set, "editor.focus", true)).rejects.toThrow("not allowed");
      expect(wc.navigate("will-navigate", url)).toBe(true);
    }
    expect(h.store.view().settings).toEqual({});
    wc.mainFrame.url = SETTINGS_URL;
    expect(await h.call(CHANNELS.set, "editor.focus", true)).toEqual({ ok: true });
    expect(wc.navigate("will-navigate", SETTINGS_URL)).toBe(false);
  });
});

/** Slots whose `list()` the test answers by hand; `stall` leaves calls unanswered. Counts calls and the most ever running at once. */
function heldSlots() {
  const waiting: ((l: SlotInfo[]) => void)[] = [];
  const s = {
    hold: false,
    stall: false,
    waiting,
    calls: 0,
    running: 0,
    most: 0,
    list: (): SlotInfo[] | Promise<SlotInfo[]> => {
      s.calls++;
      const l: SlotInfo[] = [{ id: "accounts.openai", label: "OpenAI key", status: "missing" }];
      if (s.stall) return new Promise<SlotInfo[]>(() => undefined);
      if (!s.hold) return l;
      s.running++;
      s.most = Math.max(s.most, s.running);
      return new Promise<SlotInfo[]>((r) => waiting.push((answer) => {
        s.running--;
        r(answer);
      }));
    },
    set: () => ({ ok: true as const }),
    remove: () => ({ ok: true as const }),
  };
  return s;
}
const pushedStates = (h: { win(): { webContents: { sent: { channel: string; args: unknown[] }[] } } }) =>
  h.win().webContents.sent.filter((x) => x.channel === CHANNELS.changed).map((x) => x.args[0] as SettingsView);
const openai = (status: SlotInfo["status"]): SlotInfo => ({ id: "accounts.openai", label: "OpenAI key", status });
const tick = () => new Promise((r) => setTimeout(r, 10));

describe("invariant 6 with slots that answer late", () => {
  test("a stalled slot read never holds a push back: changes every 100 ms each arrive within 1 s, the slots shown as problem", async () => {
    const slots = heldSlots();
    const h = await harness({ slots });
    h.host.openSettingsWindow();
    await tick();
    expect(((await h.call(CHANNELS.view)) as SettingsView).slots).toEqual([openai("missing")]);
    slots.stall = true;
    const callsBefore = slots.calls;
    h.win().emit("focus"); // a read that never answers
    const changedAt = new Map<number, number>();
    const arrivedAt = new Map<number, number>();
    const seen = () => {
      for (const v of pushedStates(h)) {
        const n = v.state.settings["editor.size"] as number | undefined;
        if (n !== undefined && !arrivedAt.has(n)) arrivedAt.set(n, Date.now());
      }
    };
    for (let i = 0; i < 13; i++) {
      changedAt.set(18 + i, Date.now()); // 16, the default, would leave no value to see
      void h.store.set("editor.size", 18 + i);
      h.win().emit("focus"); // asks for more reads while one is stalled: coalesced, never a second at once
      for (let t = 0; t < 10; t++) {
        await new Promise((r) => setTimeout(r, 10));
        seen();
      }
    }
    for (const [n, t] of changedAt) expect((arrivedAt.get(n) ?? Infinity) - t).toBeLessThan(1000);
    expect(pushedStates(h).at(-1)!.slots).toEqual([openai("problem")]);
    expect(slots.calls).toBe(callsBefore + 1); // the stalled read only: the asks made while it runs wait for it
  });

  test("a first read that never answers: the view lists the schema's keys as problem rows, at once and after 500 ms", async () => {
    const slots = heldSlots();
    slots.stall = true;
    const h = await harness({ slots });
    h.host.openSettingsWindow();
    expect(((await h.call(CHANNELS.view)) as SettingsView).slots).toEqual([openai("problem")]);
    await new Promise((r) => setTimeout(r, 600));
    expect(((await h.call(CHANNELS.view)) as SettingsView).slots).toEqual([openai("problem")]);
  });

  test("reads run one at a time, so no view shows a slot status older than the latest read that answered", async () => {
    const slots = heldSlots();
    slots.hold = true;
    const h = await harness({ slots });
    h.host.openSettingsWindow();
    expect(await h.call(CHANNELS.view)).toBeDefined(); // answered at once, while the read is held
    h.win().emit("focus");
    h.host.slotsChanged();
    await tick();
    expect(slots.waiting).toHaveLength(1); // the later asks wait for the first read
    slots.waiting[0]!([openai("connected")]);
    await tick();
    expect(pushedStates(h).at(-1)!.slots).toEqual([openai("connected")]);
    expect(slots.waiting).toHaveLength(2); // one more read, for the asks made while the first ran
    const viewBefore = (await h.call(CHANNELS.view)) as SettingsView;
    expect(viewBefore.slots).toEqual([openai("connected")]);
    slots.waiting[1]!([openai("missing")]);
    await tick();
    expect(((await h.call(CHANNELS.view)) as SettingsView).slots).toEqual([openai("missing")]);
    expect(pushedStates(h).at(-1)!.slots).toEqual([openai("missing")]);
    expect(slots.most).toBe(1);
    // The statuses shown, in order, are the reads' answers in the order they answered: never back to an older one.
    const shown = pushedStates(h).map((v) => v.slots[0]!.status);
    expect(shown.slice(shown.indexOf("connected"))).toEqual(["connected", "missing"]);
  });

  test("a read late by 500 ms shows the slots as problem until it answers; its answer then replaces that", async () => {
    const slots = heldSlots();
    const h = await harness({ slots });
    h.host.openSettingsWindow();
    await tick();
    await h.call(CHANNELS.view);
    slots.hold = true;
    h.win().emit("focus");
    await until(() => pushedStates(h).some((v) => v.slots[0]?.status === "problem"), 1000);
    slots.waiting[0]!([openai("connected")]);
    await until(() => pushedStates(h).at(-1)!.slots[0]?.status === "connected", 500);
  });
});

describe("the changelog's status before a key change comes from the slot cache", () => {
  test("setSecret does not wait for a read; a problem slot logs as missing", async () => {
    const slots = heldSlots();
    slots.stall = true; // the first read never answers: the cache holds the schema's row as a problem
    const h = await harness({ slots });
    h.host.openSettingsWindow("accounts");
    const callsBefore = slots.calls;
    expect(await h.call(CHANNELS.setSecret, "accounts.openai", "sk-cache-0123456789abcdef")).toEqual({ ok: true });
    expect(h.store.view().changes[0]).toMatchObject({ key: "accounts.openai", from: "missing", to: "connected" });
    expect(slots.calls).toBe(callsBefore); // the stalled read is still running; the one asked for after the save waits for it
  });

  test("a connected slot in the cache logs as connected on removal, while the adapter's next read is held", async () => {
    const slots = heldSlots();
    slots.hold = true;
    const h = await harness({ slots });
    h.host.openSettingsWindow("accounts");
    slots.waiting[0]!([openai("connected")]);
    await tick();
    expect(await h.call(CHANNELS.removeSecret, "accounts.openai")).toEqual({ ok: true });
    expect(h.store.view().changes[0]).toMatchObject({ key: "accounts.openai", from: "connected", to: "missing" });
  });
});

describe("invariant 3 for keys", () => {
  test("save and remove each log exactly one entry with who and status words; a refused save logs none", async () => {
    const h = await harness();
    h.host.openSettingsWindow("accounts");
    await h.call(CHANNELS.view);
    const KEY = "sk-changelog-key-0123456789abcdWXYZ";
    expect(await h.call(CHANNELS.setSecret, "accounts.openai", KEY)).toEqual({ ok: true });
    expect(h.store.view().changes).toEqual([expect.objectContaining({ key: "accounts.openai", from: "missing", to: "connected", who: { kind: "you" } })]);
    expect(await h.call(CHANNELS.setSecret, "accounts.openai", "bad key with spaces")).toMatchObject({ ok: false });
    expect(h.store.view().changes).toHaveLength(1);
    // The window shows the key as connected (the read after the save has answered) before it is removed.
    await until(() => pushedStates(h).at(-1)?.slots[0]?.status === "connected", 1000);
    expect(await h.call(CHANNELS.removeSecret, "accounts.openai")).toEqual({ ok: true });
    expect(h.store.view().changes).toHaveLength(2);
    expect(h.store.view().changes[0]).toMatchObject({ key: "accounts.openai", from: "connected", to: "missing", who: { kind: "you" } });
    const text = JSON.stringify(h.store.view()) + readFileSync(join(h.dir, "settings.json"), "utf8");
    expect(text).not.toContain("WXYZ");
    expect(text).not.toContain(KEY.slice(3, 15));
  });
});

test("checkForUpdates is confined to the Settings window and takes no arguments", async () => {
  let checks = 0;
  const h = await harness({ checkForUpdates: () => { checks++; } });
  h.host.openSettingsWindow();
  expect(await h.call(CHANNELS.checkForUpdates)).toEqual({ ok: true });
  expect(checks).toBe(1);
  expect(await h.call(CHANNELS.checkForUpdates, "unexpected")).toEqual(invalid);
  expect(checks).toBe(1);
});


test('view declares a legacy update checker only when the host installed one', async () => {
  const absent = await harness();
  absent.host.openSettingsWindow();
  expect(((await absent.call(CHANNELS.view)) as SettingsView).appInfo.canCheckForUpdates).toBe(false);
  const present = await harness({ checkForUpdates: async () => {} });
  present.host.openSettingsWindow();
  expect(((await present.call(CHANNELS.view)) as SettingsView).appInfo.canCheckForUpdates).toBe(true);
});


test("Electron peer compatibility admits the tested 44.7.2 and 44.9.1 exactly alongside the existing range", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const range = manifest.peerDependencies.electron;
  for (const version of ["30.0.0", "42.9.9", "44.7.2", "44.9.1"]) expect(Bun.semver.satisfies(version, range), version).toBe(true);
  for (const version of ["29.9.9", "43.0.0", "44.7.1", "44.7.3", "44.8.0", "44.9.0", "44.9.2", "44.10.0", "45.0.0"]) expect(Bun.semver.satisfies(version, range), version).toBe(false);
});
