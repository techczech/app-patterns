/**
 * Test preload: one per-run temp root for the whole `bun test` run.
 *
 * Points TMPDIR/TEMP/TMP at `<real temp>/app-patterns-testrun-XXXXXX` before any test file loads, so every
 * `os.tmpdir()`-based mkdtemp and every child process lands inside it, and removes it in a preload afterAll (exit handler as fallback)
 * (also after failures). Child bun processes inherit APP_PATTERNS_TESTRUN_ROOT and reuse it instead of nesting.
 * On exit, warns (never fails) if entries with this repo's prefixes appeared in the real temp dir during the run.
 */
import { afterAll } from "bun:test";
import { mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT_ENV = "APP_PATTERNS_TESTRUN_ROOT";
const PREFIXES = ["bridle-settings", "release-test-", "release-pack-test-"];

if (!process.env[ROOT_ENV]) {
  const realTemp = realpathSync(tmpdir());
  const startedAt = Date.now() - 1000;
  const root = mkdtempSync(join(realTemp, "app-patterns-testrun-"));
  process.env[ROOT_ENV] = root;
  process.env.TMPDIR = root;
  process.env.TEMP = root;
  process.env.TMP = root;

  let done = false;
  const teardown = () => {
    if (done) return;
    done = true;
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    try {
      const strays = readdirSync(realTemp)
        .filter((n) => PREFIXES.some((p) => n.startsWith(p)))
        .map((n) => join(realTemp, n))
        .filter((p) => { try { return statSync(p).mtimeMs >= startedAt; } catch { return false; } });
      if (strays.length) {
        console.warn(`[test-temp] ${strays.length} test folder(s) created in ${realTemp} outside the per-run root (may be another session's run):\n  ${strays.slice(0, 5).join("\n  ")}`);
      }
    } catch { /* best effort */ }
  };
  // `process.on("exit")` did not fire under bun test; afterAll in a preload runs once, after the last file.
  afterAll(teardown);
  process.on("exit", () => { if (!done) teardown(); });
}
