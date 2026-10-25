/**
 * Foreground backup helper: one owner per runtime folder, one worker per registered vault, a local socket
 * for `status` and `syncNow`, and a bounded lifetime.
 *
 * The helper runs only while its process runs. It installs nothing and starts nothing that outlives it:
 * no launch agent, login item, daemon or scheduled job. It backs up only the vaults its configuration
 * registers, each through its own engine instance with every engine guard in force (per-vault enablement,
 * cloud-folder refusal, remote checks, secret scan, exact verification). Socket requests name a vault by
 * id and can only ask for its status or an immediate cycle.
 *
 * Ownership: the runtime folder has one owner, and so does each vault. Every vault is claimed for the
 * helper's whole life with the engine's cross-process folder lock in that checkout's engine folder
 * (`<git-dir>/vault-sync/helper-owner`), so two helpers, even with different runtime folders, never both
 * schedule one vault. A vault claimed by a live helper makes a second helper refuse to start.
 *
 * Receipts: a protocol-2 connection (receipt-session.ts) reaches each vault engine's receipt API only.
 * The helper attests receipt activation only while it holds every claim and is not stopping
 * (activation.ts). Receipt work in progress counts as work: shutdown waits for it before it ends the
 * processes and releases the claims, and reports it as "receipt" when it is overdue.
 *
 * Lifecycle: ownership is released only after every piece of work this helper started has actually
 * ended, on a normal stop and on a failed start alike. That includes native processes: every Git and
 * scanner process the engines start goes through the helper's process registry (process-registry.ts),
 * which records each one's process group at launch and keeps it until the group is empty, even after the
 * command closed. `stop()` gives running cycles a grace period, then cancels them through the engine's
 * signal. Once every cycle has settled, the registry is sealed and any process still left in a recorded
 * group (the command it belonged to has ended) is killed and confirmed gone. `stop()` answers within
 * grace + hardStopMs: "stopped" once all of that has happened, the socket is removed and the claims are
 * released, "overdue" when the work has not ended, or "failed" when a shutdown step itself failed. Overdue
 * and failed both keep every claim held until the work is known to have ended (`done`): a failing registry
 * end() is retried, and a failing seal() or live() only changes the answer, never the wait. This module
 * never releases a claim while work may still be writing. An error from the socket server after the start
 * is a fault that stops the helper the same way ("failed" once the work has ended), never a crash. Ending
 * in-process work that ignores cancellation is the command line's job (see containment.ts), not this
 * module's.
 *
 * Remote visibility: a local folder or file:// remote is answered "private" (it publishes nothing beyond
 * this machine); every other address is "unknown", so the engine holds its pushes back until a later stage
 * supplies a real visibility check and credentials.
 */
import { createServer, type Server, type Socket } from "node:net";
import type { Stats } from "node:fs";
import { chmod, lstat } from "node:fs/promises";
import { devNull, hostname } from "node:os";
import { join } from "node:path";
import { createBackupEngine, type BackupEngine, type BackupEngineOptions, type RemoteVisibility } from "../engine.ts";
import { engineFolder, withFolderLock } from "../engine-store.ts";
import { createGitRunner, type ProcessLauncher } from "../git-process.ts";
import { compileScope } from "../scope.ts";
import { helperIncarnation, type PriorShutdownEvidence } from "./activation.ts";
import type { HelperConfig, RegisteredVault } from "./config.ts";
import { serveConnection } from "./connection.ts";
import { createProcessObserver, type ProcessObserver } from "./process-observer.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";
import { createProcessRegistry, type ProcessRegistry } from "./process-registry.ts";
import { createWorkTracker, type ReceiptVault } from "./receipt-session.ts";
import { assertSameFolder, prepareRuntimeFolder, removeOwnSocket, removeStaleSocket, type OwnSocketRemoval } from "./runtime-dir.ts";
import { createVaultWorker, systemClock, systemTimers, type Clock, type Timers, type VaultWorker } from "./vault-worker.ts";

export const HELPER_VERSION = "0.2.0";
/** Upper bound on one foreground run; the spike never runs open-ended. */
export const MAX_RUNTIME_MS = 6 * 60 * 60_000;
/** Upper bound on the grace period and on the time cancelled work is given to end. */
export const MAX_STOP_PHASE_MS = 10 * 60_000;
const MAX_CONNECTIONS = 16;

/** Work still running when stop reported "overdue", per vault: "cycle", "follow-up", "status-read", "receipt". */
export type UnsettledWork = Array<{ vault: string; work: string[] }>;

/**
 * What a shutdown has established, part by part.
 * - `work`: "ended" once every cycle settled and the registry's end() fulfilled; "unknown" until then.
 * - `socket`: the own socket's removal ("removed", "absent", "replaced": another file holds the path and was
 *   left in place), "not-created" when none was bound, "unverified" when one was bound but its identity was
 *   never recorded and something is at the path (left in place), "failed" when checking or removing it
 *   failed, "unknown" when not reached.
 * - `claims`: "released" once every claim's ticket was removed; "held" while shutdown runs, or when a
 *   ticket could not be removed: it then holds that claim until this process is gone.
 */
export interface ShutdownReport {
  work: "ended" | "unknown";
  socket: OwnSocketRemoval | "not-created" | "unverified" | "failed" | "unknown";
  claims: "released" | "held";
}

/** A shutdown, or a refused start's cleanup, in which some step failed. `report` says what is established. */
export class ShutdownError extends Error {
  readonly report: ShutdownReport;
  readonly faults: string[];
  constructor(faults: string[], report: ShutdownReport) {
    super(faults.join("; ").slice(0, 2_000) || "shutdown failed");
    this.name = "ShutdownError";
    this.faults = [...faults];
    this.report = { ...report };
  }
}

export type StopResult =
  /** All work ended, the socket is removed (or no longer this process's) and every claim is released. */
  | { state: "stopped" }
  /**
   * Cancelled work had not ended by grace + hardStopMs. The socket no longer accepts connections and no new
   * process may start; every claim stays held until the work ends, when `done` settles. `processGroups`
   * lists recorded process groups not yet proven empty.
   */
  | { state: "overdue"; unsettled: UnsettledWork; processGroups: number[] }
  /**
   * A shutdown step failed (`error`); the report says what was established when this was answered. Claims
   * are never released before `work` is "ended". `done` rejects with a ShutdownError once shutdown has gone
   * as far as it can; while a failing registry end() is retried, `done` stays pending and the claims held.
   */
  | ({ state: "failed"; error: string } & ShutdownReport);

export type HelperEvent =
  | { type: "started"; at: number; pid: number; socket: string; vaults: string[]; protocol: number }
  | { type: "cycle"; at: number; vault: string; reason: string; outcome: string; startedAt: number; finishedAt: number; snapshot: string | null }
  | { type: "stopping"; at: number; reason: string }
  | { type: "overdue"; at: number; unsettled: UnsettledWork; processGroups: number[] }
  /** After a started helper's shutdown: every cleanup step succeeded and the claims are released ("stopped"). */
  | { type: "stopped"; at: number; socketRemoved: boolean; socket: ShutdownReport["socket"] }
  /**
   * After a failed or refused start (never preceded by "started"): every cleanup step succeeded and the claims
   * are released. The start itself still failed.
   */
  | { type: "start-cleaned-up"; at: number; socketRemoved: boolean; socket: ShutdownReport["socket"] }
  | { type: "shutdown-fault"; at: number; fault: string };

export interface StartHelperOptions {
  config: HelperConfig;
  runtimeDir: string;
  /** Stops the helper after this long. Required; at most MAX_RUNTIME_MS. */
  maxRuntimeMs: number;
  /** How long shutdown lets running cycles finish before cancelling them. Default 20 000 ms. */
  shutdownGraceMs?: number;
  /** How long cancelled work is given to end before stop answers "overdue". Default 15 000 ms. */
  hardStopMs?: number;
  clock?: Clock;
  timers?: Timers;
  pollMs?: number;
  statusTimeoutMs?: number;
  /** Test seam: extra engine options (for example permissive guards over disposable fixtures). The CLI passes none. */
  engineOptions?: Partial<BackupEngineOptions>;
  /**
   * Records and starts every native process of this helper. Default: a new registry. The command line
   * passes its own so that it can contain those processes whatever happens to the start.
   */
  processes?: ProcessRegistry;
  /**
   * Test seam: replaces engine construction. Engines must start processes through `options.launch`. An
   * engine without `receipts` serves no receipts lane for its vault.
   */
  createEngine?: (vault: RegisteredVault, options: BackupEngineOptions) => Pick<BackupEngine, "capture" | "pushBackup" | "verify" | "status"> & Partial<Pick<BackupEngine, "receipts">>;
  onEvent?: (event: HelperEvent) => void;
  /** Test seam: read-only process observation for incarnations. Default: `ps` through the process registry. */
  observer?: ProcessObserver;
  /** Test seam: this host's name in the helper incarnation. Default `os.hostname()`. */
  host?: string;
  /**
   * The sealed shutdown report of the helper that last held receipt activation, if whoever ran it kept
   * one. Only an exact, sealed report allows a handover; otherwise only that helper's observed absence does.
   */
  priorShutdown?: PriorShutdownEvidence;
}

export interface HelperHandle {
  readonly socketPath: string;
  readonly startedAt: number;
  /**
   * Stops accepting requests and stops the workers. Answers within grace + hardStopMs (plus the time to
   * close the socket): "stopped" after the claims are released, or "overdue" with the claims still held.
   * "failed" when shutdown itself failed.
   */
  stop(reason?: string): Promise<StopResult>;
  /** The same answer as `stop`, whatever started the stop (a call, or the runtime bound). */
  readonly outcome: Promise<StopResult>;
  /**
   * Fulfils when all work has ended, the socket is removed (or no longer this process's) and every claim is
   * released. Rejects with a ShutdownError when a shutdown step failed, once no claim is held while work may
   * still run. Stays pending while work has not ended.
   */
  readonly done: Promise<void>;
  /** The registry of this helper's native processes. */
  readonly processes: ProcessRegistry;
}

/**
 * A start that failed after acquiring resources. `shutdown` says whether the work it had started has ended
 * ("stopped", claims released), not yet ("overdue", claims held until `released` settles), or whether a
 * cleanup step failed ("failed"). A refused start whose leftover processes all ended within the bound is
 * reported with its plain error instead.
 */
export class HelperStartError extends Error {
  readonly shutdown: StopResult;
  /**
   * Fulfils once shutdown has completed cleanly and the claims are released. Rejects with a ShutdownError
   * when a cleanup step failed; its report says what is established.
   */
  readonly released: Promise<void>;
  readonly processes?: ProcessRegistry;
  readonly code?: string;
  constructor(cause: unknown, shutdown: StopResult, released: Promise<void>, processes?: ProcessRegistry) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "HelperStartError";
    this.shutdown = shutdown;
    if (processes) this.processes = processes;
    this.released = released;
    // A caller that never asks still must not see an unhandled rejection.
    released.catch(() => undefined);
    const code = (cause as NodeJS.ErrnoException | null)?.code;
    if (typeof code === "string") this.code = code;
  }
}

/** Folder of a vault's helper-owner lock and its deadline record, read from Git without writing anything. */
async function vaultOwnerLock(path: string, gitEnv: Record<string, string> | undefined, launch: ProcessLauncher): Promise<{ dir: string; recordFile: string }> {
  const git = createGitRunner({ hooksDir: devNull, env: gitEnv, launch });
  const gitDir = (await git.ok(["rev-parse", "--absolute-git-dir"], { cwd: path, timeoutMs: 30_000, maxOutputBytes: 64 * 1024 })).toString("utf8").trim();
  if (!gitDir) throw new Error("could not read the vault's git folder");
  const folder = engineFolder(gitDir);
  return { dir: join(folder.dir, "helper-owner"), recordFile: folder.recordFile };
}

const LOCK_BUSY = "holds this checkout's lock";

/** Holds every vault's owner lock (none waits) while `fn` runs; a busy lock names its vault. */
async function holdVaults<T>(locks: Array<{ id: string; dir: string }>, onReleaseError: (error: unknown) => void, fn: () => Promise<T>): Promise<T> {
  const [first, ...rest] = locks;
  if (!first) return fn();
  let entered = false;
  try {
    return await withFolderLock(first.dir, { waitMs: 0, onReleaseError }, () => {
      entered = true;
      return holdVaults(rest, onReleaseError, fn);
    });
  } catch (error) {
    if (!entered && error instanceof Error && error.message.includes(LOCK_BUSY)) throw new Error(`another helper already backs up vault ${first.id}`);
    throw error;
  }
}

export function localVisibility(url: string): Promise<RemoteVisibility> {
  return Promise.resolve(url.startsWith("/") || /^file:\/\/\//i.test(url) ? "private" : "unknown");
}

interface Settleable {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/** A promise settled from outside; a rejection nobody reads is not reported as unhandled. */
function settleable(): Settleable {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/** Thrown out of the claims once a failed start's shutdown has returned; carries the start's own error. */
class StartUnwound {
  constructor(readonly failure: unknown) {}
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 500);
const socketClean = (socket: ShutdownReport["socket"]) => socket === "removed" || socket === "absent" || socket === "replaced" || socket === "not-created";

/**
 * Ends the registry. A rejected end() leaves nothing known, so it is reported and tried again (20 ms,
 * doubling to 1 s) until one fulfils. Never rejects; stays pending while end() does.
 */
async function endRegistry(processes: ProcessRegistry, onFault: (error: unknown) => void): Promise<void> {
  for (let wait = 20; ; wait = Math.min(wait * 2, 1_000)) {
    try {
      await processes.end();
      return;
    } catch (error) {
      onFault(error);
    }
    await new Promise((r) => setTimeout(r, wait));
  }
}

function phaseMs(value: number | undefined, fallback: number, name: string): number {
  const ms = value ?? fallback;
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > MAX_STOP_PHASE_MS) throw new Error(`${name} must be an integer from 0 to ${MAX_STOP_PHASE_MS}`);
  return ms;
}

export async function startHelper(options: StartHelperOptions): Promise<HelperHandle> {
  const { config } = options;
  if (!Number.isSafeInteger(options.maxRuntimeMs) || options.maxRuntimeMs <= 0 || options.maxRuntimeMs > MAX_RUNTIME_MS) {
    throw new Error(`maxRuntimeMs must be a positive integer no larger than ${MAX_RUNTIME_MS}`);
  }
  const clock = options.clock ?? systemClock;
  const timers = options.timers ?? systemTimers;
  const graceMs = phaseMs(options.shutdownGraceMs, 20_000, "shutdownGraceMs");
  const hardStopMs = phaseMs(options.hardStopMs, 15_000, "hardStopMs");
  const emit = (event: HelperEvent) => {
    try {
      options.onEvent?.(event);
    } catch {
      // Event reporting cannot affect backup.
    }
  };
  const paths = await prepareRuntimeFolder(options.runtimeDir);
  const processes = options.processes ?? createProcessRegistry();

  let resolveReady!: (handle: HelperHandle) => void;
  let rejectReady!: (error: unknown) => void;
  const ready = new Promise<HelperHandle>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  let requestStop!: (reason: string) => void;
  const stopRequested = new Promise<string>((res) => {
    requestStop = res;
  });
  let settleOutcome!: (result: StopResult) => void;
  const outcome = new Promise<StopResult>((res) => {
    settleOutcome = res;
  });
  // `done` of a started helper, and `released` of a failed start. Neither settles before the claims are
  // released or known to stay held, and neither fulfils unless every cleanup step succeeded.
  const done = settleable();
  const startReleased = settleable();

  // What shutdown has established so far, and every step that failed on the way.
  const report: ShutdownReport = { work: "unknown", socket: "unknown", claims: "held" };
  const faults: string[] = [];
  let claimLeft = false;
  const fault = (step: string, error: unknown) => {
    const text = `${step}: ${describe(error)}`;
    faults.push(text);
    emit({ type: "shutdown-fault", at: clock.now(), fault: text });
  };
  const onReleaseError = (error: unknown) => {
    claimLeft = true;
    fault("claim release", error);
  };
  const failedNow = (): StopResult => ({ state: "failed", error: faults.join("; ").slice(0, 500), ...report });
  /**
   * The final answer, once no claim is held while work may run; settles `target` to match it. A clean
   * conclusion is announced as "stopped" only for a started helper (`done`); a failed start's is
   * "start-cleaned-up".
   */
  const conclude = (target: Settleable): StopResult => {
    report.claims = claimLeft ? "held" : "released";
    if (report.work === "ended" && socketClean(report.socket) && faults.length === 0) {
      const type = target === done ? "stopped" : "start-cleaned-up";
      emit({ type, at: clock.now(), socketRemoved: report.socket === "removed", socket: report.socket });
      target.resolve();
      return { state: "stopped" };
    }
    const error = new ShutdownError(faults.length ? faults : ["shutdown did not establish that the work ended"], report);
    target.reject(error);
    return { state: "failed", error: error.message.slice(0, 500), ...report };
  };

  /**
   * A start refused before any work began, so only the lookups' processes can be left. Rejects with the
   * plain error once they have ended and nothing failed. Otherwise rejects within grace + hardStopMs with a
   * HelperStartError ("overdue", or "failed" at the first failure) whose `released` settles when they have.
   */
  const refuse = async (error: unknown): Promise<never> => {
    report.socket = "not-created";
    let faulted!: () => void;
    const firstFault = new Promise<"failed">((res) => {
      faulted = () => res("failed");
    });
    const ending = endRegistry(processes, (e) => {
      fault("processes.end", e);
      faulted();
    }).then(() => {
      report.work = "ended";
      return "ended" as const;
    });
    let bound: ReturnType<typeof setTimeout> | undefined;
    const overdue = new Promise<"overdue">((res) => { bound = setTimeout(() => res("overdue"), graceMs + hardStopMs); });
    const first = await Promise.race([ending, firstFault, overdue]);
    clearTimeout(bound);
    if (first === "ended") {
      const result = conclude(startReleased);
      if (result.state === "stopped") throw error;
      throw new HelperStartError(error, result, startReleased.promise, processes);
    }
    let result: StopResult = failedNow();
    if (first === "overdue") {
      try {
        result = { state: "overdue", unsettled: [], processGroups: processes.live() };
      } catch (e) {
        fault("processes.live", e);
        result = failedNow();
      }
    }
    void ending.then(() => conclude(startReleased));
    throw new HelperStartError(error, result, startReleased.promise, processes);
  };

  // Every lookup ends (and leaves no process behind) before a failure is reported; no claim is held yet.
  const lookups = await Promise.allSettled(config.vaults.map(async (v) => ({ id: v.id, ...(await vaultOwnerLock(v.path, options.engineOptions?.gitEnv, processes.launch)) })));
  const failed = lookups.find((l) => l.status === "rejected");
  if (failed) return refuse(failed.reason);
  const vaultLocks = lookups.map((l) => (l as PromiseFulfilledResult<{ id: string; dir: string; recordFile: string }>).value);
  const observer = options.observer ?? createProcessObserver(processes.launch);
  const identity = helperIncarnation(observer, options.host ?? hostname(), HELPER_VERSION);
  let workStarted = false;
  const claimed = withFolderLock(paths.ownerLock, { waitMs: 0, onReleaseError }, () => holdVaults(vaultLocks, onReleaseError, async () => {
    workStarted = true;
    const workers = new Map<string, VaultWorker>();
    const sockets = new Set<Socket>();
    let stopping = false;
    let server: Server | null = null;
    let listened = false;
    let own: Stats | null = null;
    let lifetime: unknown = null;
    const startedAt = clock.now();
    const receiptVaults = new Map<string, ReceiptVault>();
    // Receipt requests in progress; new ones are refused once `stopping` is set.
    const receiptWork = createWorkTracker();

    /**
     * Ends everything this start acquired, in reverse, and returns only when all work has ended. Never
     * rejects: a step that fails is reported (`fault`) and shutdown goes on, so the claims, which the
     * caller releases only after this returns, stay held while work may run. `answer` hears "overdue" once
     * work outlives grace + hardStopMs, or "failed" at the first failure before the work has ended.
     */
    const shutdown = async (reason: string, answer: (result: StopResult) => void): Promise<void> => {
      stopping = true;
      try {
        if (lifetime !== null) timers.clear(lifetime);
      } catch {
        // The bound is stopping anyway; a failing timer must not cut shutdown short.
      }
      emit({ type: "stopping", at: clock.now(), reason });
      const listening = server;
      const closed = new Promise<void>((res) => {
        if (!listening?.listening) return res();
        try {
          listening.close(() => res());
        } catch (error) {
          fault("server.close", error);
          res();
        }
      });
      // Every cycle and receipt request settles first; then nothing may start, and whatever is left in a recorded group is ended.
      const settled = Promise.allSettled([...workers.values()].map((w) => w.stop(graceMs)))
        .then(() => receiptWork.settled())
        .then(() => endRegistry(processes, (error) => {
          fault("processes.end", error);
          answer(failedNow());
        }))
        .then(() => {
          report.work = "ended";
        });
      let bound: ReturnType<typeof setTimeout> | undefined;
      // The bound only reports; it never shortens the wait below. A real timer, so a failing injected one cannot remove it.
      const overdue = new Promise<"overdue">((res) => { bound = setTimeout(() => res("overdue"), graceMs + hardStopMs); });
      const first = await Promise.race([settled.then(() => "settled" as const), overdue]);
      clearTimeout(bound);
      if (first === "overdue") {
        for (const socket of sockets) socket.destroy();
        let processGroups: number[] = [];
        try {
          processes.seal();
        } catch (error) {
          fault("processes.seal", error);
        }
        const unsettled = [...workers.values()].map((w) => ({ vault: w.id, work: [...w.unsettled(), ...(receiptWork.busy().includes(w.id) ? ["receipt"] : [])] })).filter((u) => u.work.length > 0);
        try {
          processGroups = processes.live();
        } catch (error) {
          fault("processes.live", error);
        }
        emit({ type: "overdue", at: clock.now(), unsettled, processGroups });
        answer(faults.length ? failedNow() : { state: "overdue", unsettled, processGroups });
        await settled;
      }
      for (const socket of sockets) socket.destroy();
      await closed;
      if (own) {
        try {
          report.socket = await removeOwnSocket(paths.socket, own);
        } catch (error) {
          report.socket = "failed";
          fault("socket removal", error);
        }
      } else if (listened) {
        // Bound, but its identity was never recorded: whatever is at the path is left in place.
        try {
          await lstat(paths.socket);
          report.socket = "unverified";
          fault("socket removal", new Error("a file whose identity was never recorded was left at the socket path"));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") report.socket = "absent";
          else {
            report.socket = "failed";
            fault("socket check", error);
          }
        }
      } else report.socket = "not-created";
    };

    /**
     * The server's one `error` listener, attached for its whole life so that no server error is ever
     * unhandled (an unhandled one would end the process with no shutdown, leaving Git children running and
     * the claims reclaimable while they write). While listen() is pending it fails the listen; until the
     * start has succeeded or failed it fails the start (unless a startup step already failed it); after that
     * the first one is a fault and asks for the ordinary stop, so the claims are released only after the
     * work has ended and the answer is "failed". It never releases anything itself. Later errors add
     * nothing: the stop is already under way.
     */
    let failListen: ((error: unknown) => void) | null = null;
    let startupServerError: { error: unknown } | null = null;
    let startSettled = false;
    let serverFailed = false;
    const onServerError = (error: unknown) => {
      if (failListen) return failListen(error);
      if (!startSettled) {
        startupServerError ??= { error };
        return;
      }
      if (serverFailed) return;
      serverFailed = true;
      fault("socket server", error);
      requestStop("server-error");
    };

    let startError: { error: unknown } | null = null;
    try {
      await removeStaleSocket(paths);
      for (const vault of config.vaults) {
        const engineOptions: BackupEngineOptions = { remoteVisibility: localVisibility, ...options.engineOptions, launch: processes.launch, machineId: config.machineId, remote: vault.remote };
        const engine = options.createEngine ? options.createEngine(vault, engineOptions) : createBackupEngine(engineOptions);
        const recordFile = vaultLocks.find((l) => l.id === vault.id)?.recordFile ?? null;
        receiptVaults.set(vault.id, { vault, scope: compileScope(vault.scope), receipts: engine.receipts ?? null, recordFile });
        workers.set(vault.id, createVaultWorker({
          vault, engine, intervalMs: config.captureIntervalMs, clock, timers, pollMs: options.pollMs, statusTimeoutMs: options.statusTimeoutMs,
          onCycle: (r) => emit({ type: "cycle", at: clock.now(), vault: r.vault, reason: r.reason, outcome: r.outcome, startedAt: r.startedAt, finishedAt: r.finishedAt, snapshot: r.capture?.snapshot ?? null }),
        }));
      }
      const created: Server = createServer({ allowHalfOpen: false }, (socket) => {
        if (stopping || sockets.size >= MAX_CONNECTIONS) {
          socket.destroy();
          return;
        }
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
        try {
          serveConnection(socket, {
            workers, stopping: () => stopping, startedAt, timers, helperVersion: HELPER_VERSION,
            receipts: {
              vaults: receiptVaults, helperVersion: HELPER_VERSION, identity, observer, priorShutdown: options.priorShutdown ?? null,
              // Every claim is held for as long as this callback runs; it releases them only after shutdown.
              exclusive: () => !stopping && startSettled && startError === null,
              stopping: () => stopping, track: receiptWork.track, now: () => clock.now(),
            },
          });
        } catch {
          socket.destroy();
        }
      });
      server = created;
      created.on("error", onServerError);
      await new Promise<void>((res, rej) => {
        failListen = (error) => {
          failListen = null;
          rej(error);
        };
        created.listen(paths.socket, () => {
          listened = true;
          failListen = null;
          res();
        });
      });
      // The socket was bound inside the checked folder only if that folder is still the checked object.
      await assertSameFolder(paths);
      await chmod(paths.socket, 0o600);
      own = await lstat(paths.socket);
      // Set by the server's listener while the steps above ran (TypeScript cannot see that assignment).
      const serverError = startupServerError as { error: unknown } | null;
      if (serverError) throw serverError.error;
      for (const worker of workers.values()) worker.start();
      lifetime = timers.set(() => requestStop("max-runtime"), options.maxRuntimeMs);
    } catch (error) {
      startError = { error };
    }
    startSettled = true;
    if (startError) {
      const failure = startError.error;
      await shutdown("startup-failed", (result) => {
        rejectReady(new HelperStartError(failure, result, startReleased.promise, processes));
      });
      throw new StartUnwound(failure);
    }
    emit({ type: "started", at: startedAt, pid: process.pid, socket: paths.socket, vaults: [...workers.keys()], protocol: PROTOCOL_VERSION });

    const handle: HelperHandle = {
      socketPath: paths.socket,
      startedAt,
      stop: (reason = "requested") => {
        requestStop(reason);
        return outcome;
      },
      outcome,
      done: done.promise,
      processes,
    };
    resolveReady(handle);
    await shutdown(await stopRequested, settleOutcome);
  }));
  // Every answer below comes after the claims were released, or are known to stay held. An answer already
  // given ("overdue", or "failed" at the first failure) stands; these settle `done` or `released`.
  claimed.then(() => settleOutcome(conclude(done)), (error: unknown) => {
    if (error instanceof StartUnwound) {
      rejectReady(new HelperStartError(error.failure, conclude(startReleased), startReleased.promise, processes));
      return;
    }
    if (workStarted) {
      // Not reached by design: the work callback ends only through shutdown, which never rejects.
      fault("shutdown", error);
      const result = conclude(done);
      conclude(startReleased);
      settleOutcome(result);
      rejectReady(new HelperStartError(error, result, startReleased.promise, processes));
      return;
    }
    const refused = error instanceof Error && error.message.includes(LOCK_BUSY) ? new Error("another helper already owns this runtime folder") : error;
    refuse(refused).catch(rejectReady);
  });
  return ready;
}
