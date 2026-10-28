#!/usr/bin/env bun
// Opt-in network check against Electron's exact tested declaration file; no runtime install or launch.
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./release-test-fixtures.mjs";
import { integrity, readTarEntries } from "./release-tarball.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
// Exact Electron releases admitted by the Settings Electron peer range outside its open range.
const TESTED = ["44.7.2", "44.9.1"];
for (const version of TESTED) await check(version);

async function check(version) {
  const dir = tempDir("release-test-electron-types-");
  try {
    const metadata = await fetch(`https://registry.npmjs.org/electron/${version}`, { signal: AbortSignal.timeout(30_000) });
    if (!metadata.ok) throw new Error(`Electron metadata: HTTP ${metadata.status}`);
    const pkg = await metadata.json();
    if (pkg.version !== version) throw new Error(`Electron metadata: expected ${version}, got ${pkg.version}`);
    const response = await fetch(pkg.dist.tarball, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Electron tarball: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (integrity(bytes) !== pkg.dist.integrity) throw new Error("Electron tarball integrity mismatch");
    const declaration = readTarEntries(bytes).find((entry) => entry.path === "package/electron.d.ts");
    if (!declaration) throw new Error("Electron declaration absent");
    writeFileSync(join(dir, "electron.d.ts"), declaration.data);
    writeFileSync(join(dir, "electron-contract.mts"), `
  import { BrowserWindow, Menu, app, dialog, ipcMain, safeStorage, ipcRenderer, contextBridge } from "electron";
  import type { AppLike, BrowserWindowLike, SettingsWindowOptions, IpcMainLike, Cipher, IpcRendererLike } from ${JSON.stringify(join(root, "packages/settings-electron/src/electron-types.ts"))};
  import type { MenuItem } from ${JSON.stringify(join(root, "packages/commands/src/menu-template.ts"))};
  const hostApp: AppLike = app;
  const hostIpc: IpcMainLike = ipcMain;
  const cipher: Cipher = safeStorage;
  const renderer: IpcRendererLike = ipcRenderer;
  const constructor = (opts: SettingsWindowOptions): BrowserWindowLike => new BrowserWindow(opts);
  declare const opts: SettingsWindowOptions;
  declare const items: MenuItem[];
  const win = new BrowserWindow(opts);
  Menu.setApplicationMenu(Menu.buildFromTemplate(items));
  const stay = (event: { preventDefault(): void; url: string; isMainFrame?: boolean }) => event.preventDefault();
  win.webContents.on("will-navigate", stay);
  win.webContents.on("will-frame-navigate", stay);
  win.webContents.on("will-redirect", stay);
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.once("ready-to-show", () => win.show());
  dialog.showSaveDialog(win, { title: "Export", defaultPath: "settings.json", filters: [{ name: "JSON", extensions: ["json"] }] });
  dialog.showOpenDialog(win, { properties: ["openFile", "openDirectory", "createDirectory"] });
  contextBridge.exposeInMainWorld("bridleSettings", renderer);
  `);
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({
      extends: join(root, "tsconfig.base.json"),
      compilerOptions: {
        rewriteRelativeImportExtensions: false,
        typeRoots: [join(root, "packages/settings-electron/node_modules/@types")],
        paths: { electron: [join(dir, "electron.d.ts")] },
      },
      files: [join(dir, "electron-contract.mts")],
    }));
    const result = spawnSync(process.execPath, [join(root, "packages/settings-electron/node_modules/typescript/bin/tsc"), "-p", join(dir, "tsconfig.json")], { encoding: "utf8", timeout: 30_000 });
    console.log(`Official electron@${pkg.version}: ${pkg.dist.integrity}`);
    if (result.stdout || result.stderr) console.log(result.stdout + result.stderr);
    if (result.status !== 0) throw new Error(`Electron API/type check failed (${result.status})`);
    console.log("PASS: host, IPC, cipher, bridge, navigation, window and menu API types.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
