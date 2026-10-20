import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_CHANGES } from "../changes.ts";
import { crossSchema, KEYS_PER_PROCESS, SETS, step } from "./cross-process-writer.test-support.ts";
import { tempDir } from "./node-fixture.test-support.ts";

const WRITER = join(import.meta.dir, "cross-process-writer.test-support.ts");

describe("two processes writing at once (invariant 4)", () => {
  it("2 processes × 200 interleaved sets on their own keys and one shared key lose nothing", async () => {
    const d = tempDir();
    const file = join(d, "settings.json");
    const startAt = Date.now() + 700;
    const kids = [0, 1].map((me) => Bun.spawn(["bun", WRITER, d, String(me), String(startAt)], { stdout: "pipe", stderr: "pipe" }));
    // Meanwhile the file must always parse.
    let reads = 0;
    let bad = 0;
    let running = true;
    const reader = (async () => {
      while (running) {
        if (existsSync(file)) {
          try {
            JSON.parse(readFileSync(file, "utf8"));
            reads++;
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") bad++;
          }
        }
        await Bun.sleep(1);
      }
    })();
    const results = await Promise.all(kids.map(async (k) => ({ code: await k.exited, out: await new Response(k.stdout).text(), err: await new Response(k.stderr).text() })));
    running = false;
    await reader;
    for (const r of results) {
      expect(r.err).toBe("");
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out).failures).toEqual([]);
    }
    expect(bad).toBe(0);
    expect(reads).toBeGreaterThan(0);

    const saved = JSON.parse(readFileSync(file, "utf8"));
    // Every own key holds that process's last write: nothing the other process wrote reverted it.
    for (const me of [0, 1]) {
      for (let k = 0; k < KEYS_PER_PROCESS; k++) {
        const last = Math.max(...Array.from({ length: SETS }, (_, j) => j).filter((j) => step(me, j).key === `p${me}.k${k}`).map((j) => step(me, j).value));
        expect(saved.settings[`p${me}.k${k}`]).toBe(last);
      }
    }
    // The shared key holds the last write of one of the two, and its history chains: each write saw the one before it.
    const lastShared = saved.changes.find((e: { key: string }) => e.key === "shared");
    expect(saved.settings.shared).toBe(lastShared.to);
    expect([step(0, SETS - 1).value, step(1, SETS - 1).value]).toContain(saved.settings.shared);
    // 400 sets made 400 entries; the changelog keeps the newest 300 (its cap), each one distinct, newest first, every key's chain unbroken.
    expect(saved.changes).toHaveLength(MAX_CHANGES);
    expect(new Set(saved.changes.map((e: { id: string }) => e.id)).size).toBe(MAX_CHANGES);
    const byKey = new Map<string, { from: number; to: number; at: number }[]>();
    for (const e of saved.changes) byKey.set(e.key, [...(byKey.get(e.key) ?? []), e]);
    for (const [, list] of byKey) for (let i = 0; i + 1 < list.length; i++) expect(list[i]!.from).toBe(list[i + 1]!.to);
    for (let i = 0; i + 1 < saved.changes.length; i++) expect(saved.changes[i].at).toBeGreaterThanOrEqual(saved.changes[i + 1].at);
    // Both processes' entries are among the newest: they really interleaved.
    const names = new Set(saved.changes.map((e: { who: { name: string } }) => e.who.name));
    expect(names).toEqual(new Set(["p0", "p1"]));
    expect(crossSchema.settings).toHaveLength(2 * KEYS_PER_PROCESS + 1);
    expect(existsSync(`${file}.lock`)).toBe(false);
  }, 60_000);
});
