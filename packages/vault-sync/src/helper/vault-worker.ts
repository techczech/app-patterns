/**
 * One registered vault inside the helper: its capture cadence, its single cycle at a time and its status.
 *
 * Invariants:
 * - At most one backup cycle (capture, then push, then verify) runs for a vault at any time, and no timer
 *   is armed while it runs, so a late timer, a wake from sleep or a clock jump can never start a second one.
 * - The cadence is absolute: due times are `anchor + k * interval` on the wall clock. After a late wake or
 *   a cycle longer than the interval the worker skips every missed slot and waits for the next future one;
 *   it never catches up with a burst. A monotonic fallback keeps the cadence if the wall clock jumps
 *   backwards: after each cycle the next cycle is due, by the monotonic clock, at the time left until the
 *   next wall slot and never more than one interval later.
 * - Timers are armed for at most `pollMs`, so a wall-clock jump (sleep, wake, clock change) is noticed
 *   within that time even if the platform's timers do not count time asleep.
 * - `syncNow` while a cycle runs waits for one follow-up cycle that starts after the request; several such
 *   requests share it. A request never reports a cycle that started before it was made.
 * - Reports carry the engine's own answers. "verified" means exact remote verification of the snapshot
 *   this cycle captured; nothing is inferred from push exit status, elapsed time or a previous cycle.
 */
import { BackupRefusedError, type BackupBlock } from "../blocks.ts";
import type { BackupEngine, BackupStatus, CaptureResult, PushResult, VerifyResult } from "../engine.ts";
import type { RegisteredVault } from "./config.ts";
import { ProtocolError } from "./protocol.ts";

export interface Clock {
  /** Wall-clock milliseconds. */
  now(): number;
  /** Monotonic milliseconds. */
  monotonic(): number;
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const systemClock: Clock = { now: () => Date.now(), monotonic: () => performance.now() };
export const systemTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type CycleReason = "schedule" | "syncNow";

export type CycleOutcome =
  /** The snapshot this cycle captured was verified on the remote. */
  | "verified"
  /** A guard held the cycle back (see `block`); nothing was pushed by this cycle. */
  | "blocked"
  | "capture-failed"
  | "push-failed"
  | "verify-failed"
  /** The scope produced no snapshot to push. */
  | "no-snapshot"
  /** The helper stopped before or during this cycle. */
  | "cancelled";

export interface CycleReport {
  vault: string;
  reason: CycleReason;
  startedAt: number;
  finishedAt: number;
  outcome: CycleOutcome;
  capture: { snapshot: string | null; committed: boolean; startedAt: number; changed: number; pending: string[]; skipped: number } | null;
  push: { state: PushResult["state"]; reason?: string; message?: string } | null;
  verify: { verified: boolean; state?: string; snapshot?: string; message?: string } | null;
  block: BackupBlock | null;
  error: string | null;
}

export type VaultSummary =
  /** No current engine answer: status timed out or failed. */
  | "unknown"
  | "not-enabled"
  | "blocked"
  | "error"
  | "unprotected"
  /**
   * The engine knows of no unprotected edit. Not a protection claim: edits made after the last capture are
   * unknown until the next capture, because no app adapter reports them yet.
   */
  | "no-known-unprotected-edits";

export interface VaultStatusReport {
  vault: string;
  summary: VaultSummary;
  /** Reasons the summary is less than certain; empty never means "protected". */
  uncertainty: string[];
  helper: { state: "idle" | "cycling" | "stopping" | "stopped"; cycleStartedAt: number | null; nextDueAt: number | null; lastCycle: CycleReport | null };
  /** True when `engine` was read for this request; false means it is the last known answer or null. */
  fresh: boolean;
  engineObservedAt: number | null;
  engine: BackupStatus | null;
  statusError: string | null;
}

export interface VaultWorkerOptions {
  vault: RegisteredVault;
  engine: Pick<BackupEngine, "capture" | "pushBackup" | "verify" | "status">;
  intervalMs: number;
  clock?: Clock;
  timers?: Timers;
  /** Longest single timer; bounds how late a wall-clock jump is noticed. Default 5 000 ms. */
  pollMs?: number;
  /** How long a status request waits for the engine before answering with the last known status. Default 2 000 ms. */
  statusTimeoutMs?: number;
  onCycle?: (report: CycleReport) => void;
}

export interface VaultWorker {
  readonly id: string;
  start(): void;
  syncNow(): Promise<CycleReport>;
  status(): Promise<VaultStatusReport>;
  /**
   * Stops scheduling, lets a running cycle finish for up to `graceMs`, then cancels it through the engine
   * signal and settles only when the cycle, its follow-up and any status read have actually ended. It has
   * no deadline of its own: work that ignores the signal keeps it waiting (see `unsettled`).
   */
  stop(graceMs: number): Promise<void>;
  /** Work of this vault still in progress: "cycle", "follow-up", "status-read". Empty when idle. */
  unsettled(): string[];
}

interface StatusRead {
  status: BackupStatus | null;
  error: string | null;
}

const MAX_MESSAGE = 500;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, MAX_MESSAGE);

export function createVaultWorker(options: VaultWorkerOptions): VaultWorker {
  const { vault, engine, intervalMs } = options;
  const clock = options.clock ?? systemClock;
  const timers = options.timers ?? systemTimers;
  const pollMs = options.pollMs ?? 5_000;
  const statusTimeoutMs = options.statusTimeoutMs ?? 2_000;
  const abort = new AbortController();

  let state: "new" | "running" | "stopping" | "stopped" = "new";
  let anchor = 0;
  let nextDueWall = 0;
  let nextDueMono = 0;
  let timer: unknown = null;
  let current: { promise: Promise<CycleReport>; startedAt: number } | null = null;
  let followUp: Promise<CycleReport> | null = null;
  let lastCycle: CycleReport | null = null;
  let lastKnown: { status: BackupStatus; at: number } | null = null;
  let reading: { promise: Promise<StatusRead>; startedAt: number } | null = null;
  let queuedRead: Promise<StatusRead> | null = null;
  let stopping: Promise<void> | null = null;
  let scheduleError: string | null = null;

  function schedule(): void {
    if (state !== "running" || current) return;
    const delay = Math.min(nextDueWall - clock.now(), nextDueMono - clock.monotonic());
    timer = timers.set(onTimer, Math.max(0, Math.min(pollMs, delay)));
  }

  /** Schedules from a callback, where a throw would escape; a failure is kept and shown in status. */
  function scheduleSafely(): void {
    try {
      schedule();
    } catch (error) {
      scheduleError = message(error);
    }
  }

  function onTimer(): void {
    timer = null;
    if (state !== "running" || current) return;
    if (clock.now() >= nextDueWall || clock.monotonic() >= nextDueMono) void begin("schedule");
    else scheduleSafely();
  }

  /**
   * Next slot strictly after now; missed slots are skipped, never run. The monotonic deadline is the time
   * left until that slot, capped at one interval, so it can never be already due (no catch-up) and still
   * fires on time when the wall clock has jumped backwards.
   */
  function advance(): void {
    const wall = clock.now();
    const k = Math.max(1, Math.floor((wall - anchor) / intervalMs) + 1);
    nextDueWall = anchor + k * intervalMs;
    nextDueMono = clock.monotonic() + Math.min(intervalMs, nextDueWall - wall);
  }

  function begin(reason: CycleReason): Promise<CycleReport> {
    if (timer !== null) {
      timers.clear(timer);
      timer = null;
    }
    const startedAt = clock.now();
    const promise = runCycle(reason, startedAt).catch((error): CycleReport => {
      const at = clock.now();
      return { vault: vault.id, reason, startedAt, finishedAt: at, outcome: abort.signal.aborted ? "cancelled" : "capture-failed", capture: null, push: null, verify: null, block: null, error: message(error) };
    }).then((report) => {
      lastCycle = report;
      current = null;
      advance();
      try {
        options.onCycle?.(report);
      } catch {
        // A reporting callback cannot stop the cadence.
      }
      if (followUp === null) scheduleSafely();
      return report;
    });
    current = { promise, startedAt };
    return promise;
  }

  async function runCycle(reason: CycleReason, startedAt: number): Promise<CycleReport> {
    const report: CycleReport = { vault: vault.id, reason, startedAt, finishedAt: startedAt, outcome: "cancelled", capture: null, push: null, verify: null, block: null, error: null };
    const signal = abort.signal;
    const done = (outcome: CycleOutcome) => {
      report.outcome = signal.aborted ? "cancelled" : outcome;
      report.finishedAt = clock.now();
      return report;
    };
    if (signal.aborted) return done("cancelled");
    let capture: CaptureResult;
    try {
      capture = await engine.capture(vault.path, vault.scope, { signal });
    } catch (error) {
      if (error instanceof BackupRefusedError) {
        report.block = error.block;
        return done("blocked");
      }
      report.error = message(error);
      return done("capture-failed");
    }
    report.capture = {
      snapshot: capture.snapshot,
      committed: capture.committed,
      startedAt: capture.startedAt,
      changed: capture.added.length + capture.modified.length + capture.removed.length,
      pending: capture.pending.map((p) => p.path),
      skipped: capture.skipped.length,
    };
    if (!capture.snapshot) return done("no-snapshot");
    let push: PushResult;
    try {
      push = await engine.pushBackup(vault.path, { signal });
    } catch (error) {
      report.error = message(error);
      return done("push-failed");
    }
    report.push = { state: push.state, ...("reason" in push ? { reason: push.reason } : {}), ...("message" in push ? { message: push.message.slice(0, MAX_MESSAGE) } : {}) };
    if (push.state === "blocked") {
      report.block = { reason: push.reason, at: clock.now(), message: push.message, ...(push.findings ? { findings: push.findings } : {}) };
      return done("blocked");
    }
    if (push.state !== "pushed" && push.state !== "up-to-date") return done(push.state === "no-snapshot" ? "no-snapshot" : "push-failed");
    let verify: VerifyResult;
    try {
      verify = await engine.verify(vault.path, { signal });
    } catch (error) {
      report.error = message(error);
      return done("verify-failed");
    }
    if (verify.verified) {
      report.verify = { verified: true, snapshot: verify.snapshot };
      // Verifying an older snapshot (the capture's own was replaced meanwhile) is not this cycle's success.
      return done(verify.snapshot === capture.snapshot ? "verified" : "verify-failed");
    }
    report.verify = { verified: false, state: verify.state, ...(verify.message ? { message: verify.message.slice(0, MAX_MESSAGE) } : {}) };
    if (verify.state === "blocked") {
      report.block = { reason: verify.reason, at: clock.now(), message: verify.message };
      return done("blocked");
    }
    return done("verify-failed");
  }

  /**
   * Reads engine status for a request made at `requestedAt`. A read already running that started before the
   * request is not reused for it: the request waits for one new read, which later requests share. So at most
   * one read runs and one waits, however many requests arrive while the engine is busy.
   */
  function readStatus(requestedAt: number): Promise<StatusRead> {
    if (reading && reading.startedAt >= requestedAt) return reading.promise;
    if (reading) {
      queuedRead ??= reading.promise.then(() => {
        queuedRead = null;
        return startRead();
      });
      return queuedRead;
    }
    return startRead();
  }

  function startRead(): Promise<StatusRead> {
    const startedAt = clock.monotonic();
    const promise = engine
      .status(vault.path, { signal: abort.signal })
      .then(
        (status): StatusRead => {
          lastKnown = { status, at: clock.now() };
          return { status, error: null };
        },
        (error): StatusRead => ({ status: null, error: message(error) }),
      )
      .finally(() => {
        if (reading?.promise === promise) reading = null;
      });
    reading = { promise, startedAt };
    return promise;
  }

  function summarise(engineStatus: BackupStatus | null, fresh: boolean): { summary: VaultSummary; uncertainty: string[] } {
    const uncertainty: string[] = [];
    if (!engineStatus) return { summary: "unknown", uncertainty: ["status-unavailable"] };
    if (!fresh) uncertainty.push("status-stale");
    if (engineStatus.pending.length) uncertainty.push("pending-files");
    if (engineStatus.unlistedFolders.length) uncertainty.push("unlisted-folders");
    if (engineStatus.unflushedEditSince !== null) uncertainty.push("unflushed-edits");
    if (engineStatus.writing.length) uncertainty.push("writing-in-place");
    if (engineStatus.recoveredFromDamagedRecord) uncertainty.push("recovered-deadline-record");
    if (engineStatus.block) uncertainty.push(`blocked:${engineStatus.block.reason}`);
    if (engineStatus.lastError) uncertainty.push(`last-error:${engineStatus.lastError.kind}`);
    if (lastCycle && lastCycle.outcome !== "verified") uncertainty.push(`last-cycle:${lastCycle.outcome}`);
    if (!lastCycle) uncertainty.push("no-cycle-yet");
    if (scheduleError !== null) uncertainty.push("schedule-failed");
    uncertainty.push("edits-after-last-capture-unknown");
    let summary: VaultSummary;
    if (!fresh) summary = "unknown";
    else if (!engineStatus.enabled) summary = "not-enabled";
    else if (engineStatus.block || lastCycle?.outcome === "blocked") summary = "blocked";
    else if (engineStatus.lastError || (lastCycle && lastCycle.outcome !== "verified" && lastCycle.outcome !== "no-snapshot")) summary = "error";
    else if (engineStatus.oldestUnprotectedEdit !== null || engineStatus.protectionAgeSeconds > 0 || engineStatus.pending.length || engineStatus.unlistedFolders.length || engineStatus.unflushedEditSince !== null || engineStatus.writing.length || !lastCycle) summary = "unprotected";
    else summary = "no-known-unprotected-edits";
    return { summary, uncertainty };
  }

  return {
    id: vault.id,
    start() {
      if (state !== "new") return;
      state = "running";
      anchor = clock.now();
      nextDueWall = anchor + intervalMs;
      nextDueMono = clock.monotonic() + intervalMs;
      schedule();
    },
    syncNow() {
      if (state !== "running") return Promise.reject(new ProtocolError("stopping", "the helper is not running this vault"));
      if (!current) return begin("syncNow");
      followUp ??= current.promise.then(() => {
        followUp = null;
        if (state !== "running") {
          const at = clock.now();
          return { vault: vault.id, reason: "syncNow", startedAt: at, finishedAt: at, outcome: "cancelled", capture: null, push: null, verify: null, block: null, error: null } satisfies CycleReport;
        }
        return begin("syncNow");
      });
      return followUp;
    },
    async status() {
      let fresh = false;
      let statusError: string | null = null;
      if (state !== "stopped") {
        let handle: unknown = null;
        const timeout = new Promise<null>((resolve) => { handle = timers.set(() => resolve(null), statusTimeoutMs); });
        const read = await Promise.race([readStatus(clock.monotonic()), timeout]);
        if (handle !== null) timers.clear(handle);
        if (read === null) statusError = "engine status did not answer in time";
        else if (read.error !== null) statusError = read.error;
        else fresh = true;
      } else {
        statusError = "the helper has stopped";
      }
      const engineStatus = lastKnown?.status ?? null;
      const { summary, uncertainty } = summarise(engineStatus, fresh);
      const helperState = state === "stopped" ? "stopped" : state === "stopping" ? "stopping" : current ? "cycling" : "idle";
      return {
        vault: vault.id,
        summary,
        uncertainty,
        helper: { state: helperState, cycleStartedAt: current?.startedAt ?? null, nextDueAt: state === "running" && !current ? nextDueWall : null, lastCycle },
        fresh,
        engineObservedAt: lastKnown?.at ?? null,
        engine: engineStatus,
        statusError,
      };
    },
    stop(graceMs) {
      stopping ??= (async () => {
        state = state === "new" ? "stopped" : "stopping";
        if (timer !== null) {
          timers.clear(timer);
          timer = null;
        }
        const running = current?.promise;
        if (running) {
          let handle: unknown = null;
          const grace = new Promise<void>((resolve) => {
            try {
              handle = timers.set(resolve, graceMs);
            } catch {
              resolve(); // No timer for the grace period: cancel at once rather than not at all.
            }
          });
          await Promise.race([running.then(() => undefined, () => undefined), grace]);
          if (handle !== null) timers.clear(handle);
        }
        abort.abort();
        // Cancellation reaches Git through the engine's signal. Wait until no cycle, follow-up or status read
        // is left; a read can begin while stopping, so check again after each one settles.
        for (;;) {
          const candidates: Array<Promise<unknown> | null | undefined> = [current?.promise, followUp, queuedRead, reading?.promise];
          const inFlight = candidates.filter((p): p is Promise<unknown> => p !== null && p !== undefined);
          if (!inFlight.length) break;
          await Promise.allSettled(inFlight);
        }
        state = "stopped";
      })();
      return stopping;
    },
    unsettled() {
      const busy: string[] = [];
      if (current) busy.push("cycle");
      if (followUp) busy.push("follow-up");
      if (reading || queuedRead) busy.push("status-read");
      return busy;
    },
  };
}
