import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { creditCapture, parseArgs, runLatency, summary, type Sample } from "./backup-latency.ts";

const root = fileURLToPath(new URL("./", import.meta.url));
const config = () => parseArgs(["--output", root, "--duration-ms", "100", "--interval-ms", "50", "--capture-ms", "100", "--drain-ms", "5000", "--files", "2"]);
const sample = (id: number, verifyAt: number | null): Sample => ({ id, path: "notes/document-0.md", marker: `synthetic-edit-${id}`, scheduledAt: 0, editAt: 0, flushAt: 1, captureAt: null, verifyAt });

describe("latency coverage accounting", () => {
  test("missing and ungenerated edits prevent success and remain visible", () => {
    const result = summary([sample(0, 100), sample(1, null)], 3, 1_800_000, config());
    expect(result.generated).toBe(2);
    expect(result.missing).toEqual([1]);
    expect(result.ungenerated).toBe(1);
    expect(result.allWithin300s).toBe(false);
    expect(result.acceptance).toBe(false);
  });
  test("max and nearest-rank p99 include every verified sample including overdue ones", () => {
    const result = summary(Array.from({ length: 100 }, (_, i) => sample(i, i === 99 ? 300_001 : i + 1)), 100, 100, config());
    expect(result.maxMs).toBe(300_001);
    expect(result.p99Ms).toBe(99);
    expect(result.overDeadline).toEqual([99]);
    expect(result.allWithin300s).toBe(false);
  });
  test("timestamp alone cannot credit an absent marker or an unflushed generation", () => {
    const samples = [sample(0, null), sample(1, null), { ...sample(2, null), flushAt: null }];
    const contents = new Map([[samples[0]!.path, "synthetic-edit-0\nsynthetic-edit-2\n"]]);
    expect(creditCapture(samples, contents, 10).map((s) => s.id)).toEqual([0]);
    expect(samples[1]!.captureAt).toBeNull();
    expect(samples[2]!.captureAt).toBeNull();
  });
  test("smoke cannot earn thirty-minute acceptance", () => {
    expect(summary([sample(0, 100)], 1, 2_000_000, config()).acceptance).toBe(false);
  });
  test("invalid and unbounded configurations fail before fixture creation", () => {
    for (const args of [["--files", "0"], ["--files", "101"], ["--duration-ms", "NaN"], ["--remote", "other"], ["--unknown", "x"], ["--remote", "github", "--github-repo", "owner/live-vault"]]) {
      expect(() => parseArgs(["--output", root, ...args])).toThrow();
    }
  });
  test("real engine smoke records all samples and cleans its fixture", async () => {
    const output = await mkdtemp(join(root, ".latency-test-"));
    const before = (await readdir(root)).filter((s) => s.startsWith(".latency-fixture-"));
    try {
      const run = await runLatency({ ...config(), output });
      expect(run.result.fatal).toBeNull();
      expect(run.result.generated).toBe(4);
      expect(run.result.verified).toBe(4);
      expect(run.result.allCovered).toBe(true);
      expect(run.result.acceptance).toBe(false);
      expect(JSON.parse(await readFile(join(run.output, "latency-samples.json"), "utf8"))).toHaveLength(4);
      expect((await readdir(root)).filter((s) => s.startsWith(".latency-fixture-"))).toEqual(before);
    } finally { await rm(output, { recursive: true, force: true }); }
  }, 20_000);
  test("cancellation retains uncovered samples and cleans its fixture", async () => {
    const output = await mkdtemp(join(root, ".latency-test-"));
    const before = (await readdir(root)).filter((s) => s.startsWith(".latency-fixture-"));
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), 1000);
    try {
      const run = await runLatency({ ...config(), output, durationMs: 10_000, captureMs: 5000 }, stop.signal);
      expect(run.result.aborted).toBe(true);
      expect(run.result.allCovered).toBe(false);
      expect(run.result.ungenerated).toBeGreaterThan(0);
      expect((await readdir(root)).filter((s) => s.startsWith(".latency-fixture-"))).toEqual(before);
    } finally { clearTimeout(timer); await rm(output, { recursive: true, force: true }); }
  }, 20_000);
});
