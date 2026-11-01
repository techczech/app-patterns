/** Disposable, real-wall-clock latency proof. Run with Bun; see backup-latency.md. */
import { appendFile, mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { devNull } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createBackupEngine } from "../src/engine.ts";
import { createGitRunner } from "../src/git-process.ts";

export interface Sample {
  id: number; path: string; marker: string; scheduledAt: number; editAt: number;
  flushAt: number | null; captureAt: number | null; verifyAt: number | null;
  snapshot?: string;
}
export interface Config {
  output: string; durationMs: number; intervalMs: number; captureMs: number; drainMs: number;
  files: number; remote: "local" | "github"; githubRepo?: string;
  fault: "none" | "unavailable" | "slow-push" | "large-asset";
  faultAtMs: number; outageMs: number; slowMs: number; assetBytes: number;
}
/** Test-only seam. Callbacks must await all work and cooperate with signal/deadlineAt.
 * Timeout requests cancellation; it cannot hard-stop arbitrary JavaScript. Cleanup waits
 * for settlement even after cancellation. Never detach callback work or use a race.
 */
export interface LatencyObservationContext {
  readonly fixture: string;
  readonly repo: string;
  /** Owned local bare remote; absent for GitHub. No credentials or remote URLs. */
  readonly localRemote: string | null;
  readonly output: string;
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
}
export interface LatencyTestHooks {
  beforeCleanup: (context: LatencyObservationContext) => void | Promise<void>;
  /** Cooperative budget, 1..120000 ms; defaults to 30000. */
  timeoutMs?: number;
}
type ObservationStatus = "not-requested" | "passed" | "failed" | "timed-out" | "cancelled";
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const delay = (ms: number, signal?: AbortSignal) => new Promise<void>((res) => {
  if (signal?.aborted || ms <= 0) return res();
  const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); res(); };
  const timer = setTimeout(done, ms);
  signal?.addEventListener("abort", done, { once: true });
});

/** Output and wall time are bounded; raw command stderr never enters receipts. */
export function command(name: string, args: string[], cwd: string, timeout = 30_000): Promise<string> {
  return new Promise((res, rej) => {
    const child = spawn(name, args, { cwd, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    let failed = false;
    const kill = () => { try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch {} };
    const timer = setTimeout(() => { failed = true; kill(); }, timeout);
    child.stdout.on("data", (b: Buffer) => { output += b.toString(); if (output.length > 1_000_000) { failed = true; kill(); } });
    child.on("error", () => { clearTimeout(timer); rej(new Error(`${name} unavailable`)); });
    child.on("close", (code) => { clearTimeout(timer); code === 0 && !failed ? res(output.trim()) : rej(new Error(`${name} failed or exceeded its bound`)); });
  });
}
export function validate(config: Config): void {
  for (const key of ["durationMs", "intervalMs", "captureMs", "drainMs", "files", "outageMs", "slowMs", "assetBytes"] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw new Error(`${key} must be a positive integer`);
  }
  if (!Number.isSafeInteger(config.faultAtMs) || config.faultAtMs < 0) throw new Error("faultAtMs must be nonnegative");
  if (Math.ceil(config.durationMs / config.intervalMs) * config.files > 100_000 || config.files > 100 || config.durationMs > 3_600_000 || config.drainMs > 600_000 || config.assetBytes > 50 * 1024 * 1024 || config.slowMs > 120_000) throw new Error("configuration exceeds harness bounds");
  if (!["local", "github"].includes(config.remote) || !["none", "unavailable", "slow-push", "large-asset"].includes(config.fault)) throw new Error("unknown remote or fault");
  if (config.remote === "github" && (!config.githubRepo || !/^[A-Za-z0-9-]+\/vault-sync-test-fixture$/.test(config.githubRepo))) throw new Error("GitHub target must be OWNER/vault-sync-test-fixture");
  if (config.remote === "github" && ["unavailable", "slow-push"].includes(config.fault)) throw new Error("transport fault injection requires a local disposable remote");
  if (config.fault !== "none" && config.faultAtMs >= config.durationMs) throw new Error("fault must start during typing");
}
export function summary(samples: Sample[], expected: number, elapsedMs: number, config: Config) {
  const values = samples.filter((s) => s.verifyAt !== null).map((s) => s.verifyAt! - s.editAt).sort((a, b) => a - b);
  const missing = samples.filter((s) => s.verifyAt === null).map((s) => s.id);
  const allCovered = samples.length === expected && missing.length === 0;
  const maxMs = values.at(-1) ?? null;
  return {
    expected, generated: samples.length, verified: values.length, missing,
    ungenerated: Math.max(0, expected - samples.length), allCovered,
    maxMs, p99Ms: values.length ? values[Math.ceil(values.length * 0.99) - 1] : null,
    overDeadline: samples.filter((s) => s.verifyAt !== null && s.verifyAt - s.editAt > 300_000).map((s) => s.id),
    elapsedMs, allWithin300s: allCovered && maxMs !== null && maxMs <= 300_000,
    actualThirtyMinuteTiming: config.durationMs >= 1_800_000 && elapsedMs >= 1_800_000 && config.intervalMs === 1000 && config.captureMs === 60_000,
    acceptance: config.fault === "none" && config.durationMs >= 1_800_000 && elapsedMs >= 1_800_000 && config.intervalMs === 1000 && config.captureMs === 60_000 && allCovered && maxMs !== null && maxMs <= 300_000,
  };
}
/** Credit only markers read from the immutable snapshot, never timestamp coverage alone. */
export function creditCapture(samples: Sample[], contents: Map<string, string>, capturedAt: number): Sample[] {
  return samples.filter((sample) => {
    if (sample.flushAt === null || sample.flushAt > capturedAt || !contents.get(sample.path)?.split("\n").includes(sample.marker)) return false;
    sample.captureAt ??= capturedAt;
    return true;
  });
}

export async function runLatency(config: Config, signal?: AbortSignal, hooks?: LatencyTestHooks) {
  validate(config);
  const observationBudget = hooks?.timeoutMs ?? 30_000;
  if (hooks && (!Number.isSafeInteger(observationBudget) || observationBudget <= 0 || observationBudget > 120_000)) throw new Error("invalid observation budget");
  const observation: { status: ObservationStatus; failure: string | null } = { status: "not-requested", failure: null };
  let timingElapsedMs: number | undefined;
  const runId = `latency-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const output = resolve(config.output, runId);
  await mkdir(output, { recursive: true });
  // All scratch, including scanner scratch, is owned by this fixture and removed in finally.
  const fixture = await realpath(await mkdtemp(join(packageRoot, "scripts/.latency-fixture-")));
  const previousTemp = process.env.TMPDIR;
  process.env.TMPDIR = fixture;
  const repo = join(fixture, "vault");
  const remote = join(fixture, "remote.git");
  const hiddenRemote = join(fixture, "offline.git");
  const git = createGitRunner({ hooksDir: devNull, env: { GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" } });
  const gitAt = async (cwd: string, args: string[]) => (await git.ok(args, { cwd, timeoutMs: 30_000, maxOutputBytes: 64 * 1024 * 1024 })).toString("utf8");
  const events = join(output, "latency-events.jsonl");
  const emit = (event: object) => appendFile(events, JSON.stringify({ at: Date.now(), ...event }) + "\n");
  const samples: Sample[] = [];
  const notes: Promise<void>[] = [];
  const stop = new AbortController();
  const abort = () => stop.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) stop.abort();
  let start = Date.now();
  let faultApplied = false;
  let faultEnded: number | null = null;
  let recoveredAt: number | null = null;
  let noteFailed = false;
  let fatal: string | null = null;
  let writer: Promise<void> | undefined;
  let faultWorker: Promise<void> | undefined;
  let offline = false;
  let assetDigest: string | null = null;
  let assetVerifiedAt: number | null = null;
  const slowMarker = join(fixture, "slow-push-active");
  try {
    await writeFile(join(output, "latency-run.json"), JSON.stringify({ runId, pid: process.pid, config, startedAt: start, state: "starting", scanner: "real gitleaks", visibility: config.remote === "github" ? "authenticated gh API" : "harness-only local bare remote classification" }, null, 2));
    await command("gitleaks", ["version"], fixture);
    await gitAt(fixture, ["init", "-q", "-b", "main", repo]);
    let url = remote;
    if (config.remote === "github") {
      const owner = (await command("gh", ["api", "user", "--jq", ".login"], fixture)).trim();
      if (config.githubRepo!.split("/")[0] !== owner) throw new Error("fixture owner differs from authenticated owner");
      const info = JSON.parse(await command("gh", ["api", `repos/${config.githubRepo}`], fixture));
      if (!info.private || info.name !== "vault-sync-test-fixture" || info.owner.login !== owner) throw new Error("fixture ownership or privacy check failed");
      // Creation is a separate explicit supported gh command; this harness never creates or deletes repositories.
      url = `https://github.com/${config.githubRepo}.git`;
    } else await gitAt(fixture, ["init", "-q", "--bare", remote]);
    await gitAt(repo, ["remote", "add", "origin", url]);
    await mkdir(join(repo, "notes"));
    // A wrapper delays actual native push only, without replacing engine guards or verification.
    let gitPath: string | undefined;
    if (config.fault === "slow-push") {
      gitPath = join(fixture, "slow-git");
      await writeFile(gitPath, `#!${process.execPath}\nimport { spawn } from 'node:child_process';\nimport { existsSync, unlinkSync } from 'node:fs';\nimport { join } from 'node:path';\nconst args=process.argv.slice(2);\nconst marker=join(import.meta.dir,'slow-push-active');\nif(args.includes('push') && existsSync(marker)) { await new Promise(r=>setTimeout(r,${config.slowMs})); unlinkSync(marker); }\nconst child=spawn('git',args,{stdio:'inherit',shell:false});\nchild.on('close',code=>process.exit(code??1));\nchild.on('error',()=>process.exit(1));\n`, { mode: 0o700 });
    }
    const engine = createBackupEngine({
      machineId: runId, gitPath, networkTimeoutMs: 150_000,
      // Git invokes gh's credential helper, trusted explicitly (the engine clears repository helpers); credentials are never retrieved by the harness.
      trustedCredentialHelpers: config.remote === "github" ? ["!gh auth git-credential"] : [],
      remoteVisibility: async () => {
        if (config.remote === "local") return "private";
        const info = JSON.parse(await command("gh", ["api", `repos/${config.githubRepo}`], fixture));
        return info.private === true ? "private" : info.private === false ? "public" : "unknown";
      },
      // All location, per-vault enablement and secret-scan defaults remain enabled.
    });
    await engine.enable(repo);
    start = Date.now();
    const expected = Math.ceil(config.durationMs / config.intervalMs) * config.files;
    await emit({ type: "started", runId, pid: process.pid, expected, start });
    writer = (async () => {
      for (let tick = 0; tick * config.intervalMs < config.durationMs; tick++) {
        await delay(start + tick * config.intervalMs - Date.now(), stop.signal);
        if (stop.signal.aborted) break;
        for (let file = 0; file < config.files; file++) {
          const id = samples.length;
          const sample: Sample = { id, path: `notes/document-${file}.md`, marker: `synthetic-edit-${id}`, scheduledAt: start + tick * config.intervalMs, editAt: Date.now(), flushAt: null, captureAt: null, verifyAt: null };
          samples.push(sample);
          // Do not let the engine's serial push queue stop the independent synthetic typist.
          // Each edit is reported for its document; its ticket is what that document's save acknowledges.
          const ticket = engine.noteEdit(repo, sample.editAt, { path: sample.path });
          notes.push(ticket.then(() => undefined, () => { noteFailed = true; }));
          // In-place appends follow the coordinated-writer contract: write start before, durable save after.
          const writeToken = await engine.noteWriteStart(repo, [sample.path]).catch((error) => { noteFailed = true; throw error; });
          const handle = await open(join(repo, sample.path), "a");
          try { await handle.write(`${sample.marker}\n`); await handle.sync(); sample.flushAt = Date.now(); }
          finally { await handle.close(); }
          await ticket.then((upTo) => engine.noteFlush(repo, { upTo, paths: [sample.path], completedWrites: [{ path: sample.path, token: writeToken }] })).catch(() => { noteFailed = true; });
          await emit({ type: "edit", sample: { ...sample } });
        }
      }
      await delay(start + config.durationMs - Date.now(), stop.signal);
    })();
    // Catch immediately: failure still leaves generated/unflushed samples in the final receipt.
    writer.catch(() => { fatal = "typing failed"; stop.abort(); });
    faultWorker = (async () => {
      if (config.fault === "none") return;
      await delay(start + config.faultAtMs - Date.now(), stop.signal);
      if (stop.signal.aborted) return;
      faultApplied = true;
      await emit({ type: "fault-start", fault: config.fault });
      if (config.fault === "unavailable") {
        await rename(remote, hiddenRemote); offline = true;
        await delay(config.outageMs, stop.signal);
        await rename(hiddenRemote, remote); offline = false;
      } else if (config.fault === "slow-push") {
        await writeFile(slowMarker, "active");
        while (!stop.signal.aborted) {
          try { await readFile(slowMarker); } catch { break; }
          await delay(100, stop.signal);
        }
      } else if (config.fault === "large-asset") {
        // Text remains below the default scan limit; scanner guards are not lifted.
        const assetEditAt = Date.now();
        const assetTicket = await engine.noteEdit(repo, assetEditAt, { path: "notes/large-asset.txt" });
        const writeToken = await engine.noteWriteStart(repo, ["notes/large-asset.txt"]);
        const handle = await open(join(repo, "notes/large-asset.txt"), "w");
        const bytes = Buffer.alloc(config.assetBytes, 97);
        assetDigest = createHash("sha256").update(bytes).digest("hex");
        try { await handle.write(bytes); await handle.sync(); }
        finally { await handle.close(); }
        await engine.noteFlush(repo, { upTo: assetTicket, paths: ["notes/large-asset.txt"], completedWrites: [{ path: "notes/large-asset.txt", token: writeToken }] });
      }
      faultEnded = Date.now();
      await emit({ type: "fault-end", fault: config.fault, assetBytes: config.fault === "large-asset" ? config.assetBytes : undefined });
    })();
    faultWorker.catch(() => { fatal = "fault injection failed"; stop.abort(); });
    let nextCapture = start + config.captureMs;
    const end = start + config.durationMs + config.drainMs;
    while (!stop.signal.aborted && Date.now() < end) {
      await delay(Math.min(nextCapture, end) - Date.now(), stop.signal);
      if (stop.signal.aborted || Date.now() >= end) break;
      try {
        const capture = await engine.capture(repo, { include: ["notes"] }, { signal: stop.signal });
        await emit({ type: "capture", snapshot: capture.snapshot, captureAt: capture.startedAt, pending: capture.pending, skipped: capture.skipped });
        if (capture.snapshot) {
          const contents = new Map<string, string>();
          for (let f = 0; f < config.files; f++) {
            const path = `notes/document-${f}.md`;
            try { contents.set(path, await gitAt(repo, ["show", `${capture.snapshot}:${path}`])); } catch { /* missing path never earns coverage */ }
          }
          let assetCaptured = false;
          if (assetDigest !== null) {
            try { assetCaptured = createHash("sha256").update(await gitAt(repo, ["show", `${capture.snapshot}:notes/large-asset.txt`])).digest("hex") === assetDigest; } catch {}
          }
          const covered = creditCapture(samples, contents, capture.startedAt);
          const push = await engine.pushBackup(repo, { signal: stop.signal });
          await emit({ type: "push", state: push.state, reason: "reason" in push ? push.reason : undefined });
          if (push.state === "pushed" || push.state === "up-to-date") {
            const verify = await engine.verify(repo, { signal: stop.signal });
            const at = Date.now();
            await emit({ type: "verify", ...verify });
            if (verify.verified && verify.snapshot === capture.snapshot) {
              for (const s of covered) if (s.verifyAt === null) { s.verifyAt = at; s.snapshot = verify.snapshot; await emit({ type: "protected", id: s.id, captureAt: s.captureAt, verifyAt: at, snapshot: s.snapshot }); }
              if (assetCaptured) assetVerifiedAt ??= at;
              if (faultEnded !== null && recoveredAt === null && covered.length && (config.fault !== "large-asset" || assetCaptured)) recoveredAt = at;
            }
          }
        }
        const status = await engine.status(repo);
        await emit({ type: "status", protectionAgeSeconds: status.protectionAgeSeconds, oldestUnprotectedEdit: status.oldestUnprotectedEdit, warning: status.block?.reason ?? status.lastError?.kind ?? null, overdue: status.protectionAgeSeconds > 300, pending: status.pending });
      } catch {
        if (!stop.signal.aborted) await emit({ type: "cycle-failed" });
      }
      if (Date.now() >= start + config.durationMs && samples.length === expected && samples.every((s) => s.verifyAt !== null) && (config.fault === "none" || (faultApplied && recoveredAt !== null))) break;
      // Maintain the absolute minute cadence; long operations cannot trigger an unbounded catch-up loop.
      nextCapture += config.captureMs;
      if (nextCapture < Date.now()) nextCapture = Date.now();
    }
    await writer;
    stop.abort();
    await faultWorker;
    await Promise.all(notes);
    if (noteFailed) fatal = "one or more deadline edit notifications failed";
  } catch {
    fatal ??= "setup or run failed; inspect structured events and prerequisites";
  } finally {
    stop.abort();
    await Promise.allSettled([writer, faultWorker, ...notes].filter(Boolean) as Promise<unknown>[]);
    if (offline) await rename(hiddenRemote, remote).catch(() => {});
    signal?.removeEventListener("abort", abort);
    if (previousTemp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTemp;
    if (hooks) {
      // Freeze timing before independent archive I/O. This callback never credits samples.
      timingElapsedMs = Date.now() - start;
      const observationStop = new AbortController();
      const cancelObservation = () => observationStop.abort();
      signal?.addEventListener("abort", cancelObservation, { once: true });
      if (signal?.aborted) observationStop.abort();
      let timedOut = false;
      const deadlineAt = Date.now() + observationBudget;
      const timer = setTimeout(() => { timedOut = true; observationStop.abort(); }, observationBudget);
      let failed = false;
      try {
        await hooks.beforeCleanup({ fixture, repo, localRemote: config.remote === "local" ? remote : null, output, signal: observationStop.signal, deadlineAt });
      } catch { failed = true; }
      finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancelObservation);
        observation.status = signal?.aborted ? "cancelled" : timedOut || Date.now() >= deadlineAt ? "timed-out" : failed ? "failed" : "passed";
        observation.failure = observation.status === "passed" ? null : "independent observation did not complete successfully";
        await rm(fixture, { recursive: true, force: true });
      }
    } else await rm(fixture, { recursive: true, force: true });
  }
  const result = { runId, ...summary(samples, Math.ceil(config.durationMs / config.intervalMs) * config.files, timingElapsedMs ?? Date.now() - start, config), observation, fault: config.fault, faultApplied, faultEnded, recoveredAt, recoveryMs: faultEnded !== null && recoveredAt !== null ? recoveredAt - faultEnded : null, assetVerifiedAt, assetDigest, maxScheduleLatenessMs: samples.length ? Math.max(...samples.map((s) => s.editAt - s.scheduledAt)) : null, aborted: signal?.aborted ?? false, fatal, fixtureCleaned: true };
  if (fatal || result.aborted || !["not-requested", "passed"].includes(observation.status)) result.acceptance = false;
  await writeFile(join(output, "latency-samples.json"), JSON.stringify(samples, null, 2));
  await writeFile(join(output, "latency-summary.json"), JSON.stringify(result, null, 2));
  await emit({ type: "finished", ...result });
  return { output, result };
}

export function parseArgs(args: string[]): Config {
  const values: Record<string, string> = {};
  const allowed = new Set(["output", "duration-ms", "interval-ms", "capture-ms", "drain-ms", "files", "remote", "github-repo", "fault", "fault-at-ms", "outage-ms", "slow-ms", "asset-bytes"]);
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, "");
    if (!key || !args[i]?.startsWith("--") || !allowed.has(key) || !args[i + 1] || values[key] !== undefined) throw new Error("use unique --key value arguments from backup-latency.md");
    values[key] = args[i + 1]!;
  }
  if (!values.output) throw new Error("--output is required");
  const config: Config = { output: values.output, durationMs: Number(values["duration-ms"] ?? 1_800_000), intervalMs: Number(values["interval-ms"] ?? 1000), captureMs: Number(values["capture-ms"] ?? 60_000), drainMs: Number(values["drain-ms"] ?? 300_000), files: Number(values.files ?? 3), remote: (values.remote ?? "local") as Config["remote"], githubRepo: values["github-repo"], fault: (values.fault ?? "none") as Config["fault"], faultAtMs: Number(values["fault-at-ms"] ?? 120_000), outageMs: Number(values["outage-ms"] ?? 180_000), slowMs: Number(values["slow-ms"] ?? 20_000), assetBytes: Number(values["asset-bytes"] ?? 8 * 1024 * 1024) };
  validate(config);
  return config;
}
if (import.meta.main) {
  const stop = new AbortController();
  process.once("SIGINT", () => stop.abort());
  process.once("SIGTERM", () => stop.abort());
  try {
    const { output, result } = await runLatency(parseArgs(process.argv.slice(2)), stop.signal);
    console.log(JSON.stringify({ output, ...result }));
    process.exitCode = result.fatal || result.aborted || !result.allCovered || (result.fault === "none" && !result.allWithin300s) || (result.fault !== "none" && (!result.faultApplied || result.recoveredAt === null)) ? 1 : 0;
  } catch { console.error("latency harness configuration or output failed"); process.exitCode = 1; }
}
