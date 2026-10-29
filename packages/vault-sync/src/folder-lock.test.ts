import { setDefaultTimeout, afterEach, describe, expect, test } from "bun:test";
setDefaultTimeout(60_000);
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engineFolder, lockTestHooks, withFolderLock, type EngineFolder } from "./engine-store.ts";

/** Far above any real pid limit, so the owner is certainly gone (kill(pid, 0) reports ESRCH). */
const DEAD_PID = 2_000_000_000;
const roots: string[] = [];
afterEach(() => {
  lockTestHooks.beforeRemoveDead = undefined;
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function folder(): EngineFolder {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vault-sync-lock-")));
  roots.push(root);
  const f = engineFolder(root);
  mkdirSync(f.lockDir, { recursive: true });
  return f;
}

/** A crashed owner: its ticket (and an unfinished announcement) remain in the lock folder. */
function plantDeadOwner(f: EngineFolder, number = 1): void {
  writeFileSync(join(f.lockDir, `ticket-${String(number).padStart(12, "0")}-${DEAD_PID}-${"d".repeat(12)}`), "");
  writeFileSync(join(f.lockDir, `choosing-${DEAD_PID}-${"c".repeat(12)}`), "");
}

/** Critical section that detects overlap with an exclusive-create marker, so it works across processes too. */
function section(f: EngineFolder, record: { overlaps: number; entries: number }, holdMs: () => number) {
  const marker = join(f.dir, "in-section");
  return async () => {
    try {
      writeFileSync(marker, String(process.pid), { flag: "wx" });
    } catch {
      record.overlaps += 1;
      return;
    }
    record.entries += 1;
    await new Promise((resolve) => setTimeout(resolve, holdMs()));
    unlinkSync(marker);
  };
}

describe("stale-lock takeover keeps one owner (review finding 10)", () => {
  test("a reclaimer delayed between deciding and removing never removes a live owner's lock", async () => {
    const f = folder();
    plantDeadOwner(f);
    const record = { overlaps: 0, entries: 0 };
    let releaseFirst!: () => void;
    const firstPaused = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let reachedHook!: () => void;
    const hookReached = new Promise<void>((resolve) => { reachedHook = resolve; });
    let paused = false;
    lockTestHooks.beforeRemoveDead = async (name) => {
      // The first contender to decide a dead owner's file must go is held right before it removes it.
      if (!paused && name.startsWith("ticket-")) {
        paused = true;
        reachedHook();
        await firstPaused;
      }
    };
    const run = section(f, record, () => 20);
    const first = withFolderLock(f.lockDir, { waitMs: 20_000 }, run);
    await hookReached;
    // Meanwhile others reclaim the same dead owner and try to enter.
    const others = Array.from({ length: 5 }, () => withFolderLock(f.lockDir, { waitMs: 20_000 }, run));
    await new Promise((resolve) => setTimeout(resolve, 200));
    releaseFirst();
    await Promise.all([first, ...others]);
    expect(record.overlaps).toBe(0);
    expect(record.entries).toBe(6);
    expect(readdirSync(f.lockDir)).toEqual([]);
  });

  test("twelve contenders recovering from a dead owner, three rounds, never overlap", async () => {
    const f = folder();
    const record = { overlaps: 0, entries: 0 };
    lockTestHooks.beforeRemoveDead = () => new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
    for (let round = 0; round < 3; round += 1) {
      plantDeadOwner(f, round + 1);
      const run = section(f, record, () => Math.random() * 4);
      await Promise.all(Array.from({ length: 12 }, () => withFolderLock(f.lockDir, { waitMs: 30_000 }, run)));
    }
    expect(record.overlaps).toBe(0);
    expect(record.entries).toBe(36);
    expect(readdirSync(f.lockDir)).toEqual([]);
  });

  test("separate processes recovering from a dead owner never overlap", async () => {
    const f = folder();
    plantDeadOwner(f);
    const store = join(import.meta.dir, "engine-store.ts");
    const results = join(f.dir, "results");
    mkdirSync(results);
    const child = (index: number) => new Promise<number>((resolve) => {
      const code = `
        import { writeFileSync, unlinkSync, appendFileSync } from "node:fs";
        import { withFolderLock } from ${JSON.stringify(store)};
        const folder = ${JSON.stringify(f)};
        let overlaps = 0, entries = 0;
        for (let i = 0; i < 6; i += 1) {
          await withFolderLock(folder.lockDir, { waitMs: 30000 }, async () => {
            try { writeFileSync(${JSON.stringify(join(f.dir, "in-section"))}, "x", { flag: "wx" }); } catch { overlaps += 1; return; }
            entries += 1;
            await new Promise((r) => setTimeout(r, Math.random() * 4));
            unlinkSync(${JSON.stringify(join(f.dir, "in-section"))});
          });
        }
        writeFileSync(${JSON.stringify(results)} + "/${index}.json", JSON.stringify({ overlaps, entries }));
      `;
      const proc = spawn(process.execPath, ["-e", code], { stdio: ["ignore", "ignore", "inherit"] });
      proc.on("close", (status) => resolve(status ?? -1));
    });
    const local = { overlaps: 0, entries: 0 };
    const run = section(f, local, () => Math.random() * 4);
    const inProcess = Array.from({ length: 4 }, async () => {
      for (let i = 0; i < 6; i += 1) await withFolderLock(f.lockDir, { waitMs: 30_000 }, run);
    });
    const codes = await Promise.all([...Array.from({ length: 4 }, (_, i) => child(i)), ...inProcess.map((p) => p.then(() => 0))]);
    expect(codes).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    let overlaps = local.overlaps;
    let entries = local.entries;
    for (const name of readdirSync(results)) {
      const r = JSON.parse(readFileSync(join(results, name), "utf8")) as { overlaps: number; entries: number };
      overlaps += r.overlaps;
      entries += r.entries;
    }
    expect(overlaps).toBe(0);
    expect(entries).toBe(48);
    expect(readdirSync(f.lockDir)).toEqual([]);
  });

  test("a live owner is waited for, and the waiter gives up without removing its lock", async () => {
    const f = folder();
    let release!: () => void;
    const held = withFolderLock(f.lockDir, { waitMs: 1000 }, () => new Promise<void>((resolve) => { release = resolve; }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const waiter = await withFolderLock(f.lockDir, { waitMs: 200 }, async () => "entered").catch((e: Error) => e.message);
    expect(waiter).toContain("holds this checkout's lock");
    expect(readdirSync(f.lockDir).filter((n) => n.startsWith("ticket-")).length).toBe(1);
    release();
    await held;
    expect(readdirSync(f.lockDir)).toEqual([]);
  });
});
