/**
 * One update in its own process with `process.platform` set, for the folder fsync tests:
 * `bun dir-sync-platform.test-support.ts <dir> <platform> <failure>`. The setting never leaks into the test runner.
 * failure: `dir-EPERM` / `dir-EIO` (the folder opens, its fsync fails), `rename-EPERM` (the commit itself fails).
 * Prints one JSON line: the update result and the file's text afterwards (null if absent).
 */
import { constants, existsSync, readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { SettingsFile, type SettingsFileTestHooks } from "./settings-file.ts";

const [dir, platform, failure] = process.argv.slice(2) as [string, string, string];
Object.defineProperty(process, "platform", { value: platform });

const errno = (code: string, syscall: string) => Object.assign(new Error(`${code}: ${syscall}`), { code, syscall });
const hooks: SettingsFileTestHooks = {};
if (failure === "dir-EPERM" || failure === "dir-EIO") {
  const code = failure.slice("dir-".length);
  hooks.openDir = async (d) => {
    const fh = await open(d, constants.O_RDONLY);
    return { sync: () => Promise.reject(errno(code, "fsync")), close: () => fh.close() };
  };
} else if (failure === "rename-EPERM") {
  hooks.beforeRename = () => {
    throw errno("EPERM", "rename");
  };
} else throw new Error(`unknown failure ${failure}`);

const path = join(dir, "settings.json");
const file = new SettingsFile(path, { testHooks: hooks });
const r = await file.update(() => ({ write: { folder: "C:\\Reports" }, result: "saved" }));
console.log(JSON.stringify({ platform: process.platform, r, text: existsSync(path) ? readFileSync(path, "utf8") : null }));
