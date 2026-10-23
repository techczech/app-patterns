/** Temporary folders and a store over the shared test schema, for the node layer's tests. */
import { afterEach } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commands, schema } from "../fixture.test-support.ts";
import type { SettingsState } from "../state.ts";
import { SettingsStore, type SettingsStoreOptions } from "./settings-store.ts";

const made: string[] = [];
// bun runs a shared module's afterEach only for the first test file that loads it, so also sweep at process exit.
let exitHooked = false;
function ensureExitCleanup(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", () => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });
}
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fresh folder (real path, so containment checks compare like with like), removed after the test. */
export function tempDir(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "bridle-settings-")));
  made.push(d);
  ensureExitCleanup();
  return d;
}

export async function openStore(dir: string, more: Partial<SettingsStoreOptions> = {}): Promise<SettingsStore & { changes: SettingsState[]; lines: string[] }> {
  const changes: SettingsState[] = [];
  const lines: string[] = [];
  const s = new SettingsStore({
    dir, app: "editorexample", schema, registry: commands, appVersion: "0.31.0", watch: false,
    onChange: (st) => changes.push(st), log: (l) => lines.push(l), ...more,
  }) as SettingsStore & { changes: SettingsState[]; lines: string[] };
  s.changes = changes;
  s.lines = lines;
  await s.ready;
  return s;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolves when `check` holds, polling; rejects after `ms`. */
export async function until(check: () => boolean, ms: number): Promise<number> {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > ms) throw new Error(`condition not met within ${ms} ms`);
    await sleep(10);
  }
  return Date.now() - t0;
}

export { commands, schema };
