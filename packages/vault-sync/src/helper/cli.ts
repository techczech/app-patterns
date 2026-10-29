/**
 * Foreground helper command line (spike). Run with Bun:
 *
 *   bun src/helper/cli.ts run --config <file> --runtime-dir <folder> --max-runtime-ms <ms>
 *                             [--shutdown-grace-ms <ms>] [--hard-stop-ms <ms>]
 *   bun src/helper/cli.ts status --runtime-dir <folder> [--vault <id>]
 *   bun src/helper/cli.ts sync-now --runtime-dir <folder> --vault <id>
 *   bun src/helper/cli.ts preview --config <file> --vault <id>
 *   bun src/helper/cli.ts enable --config <file> --vault <id> [--confirm-public] [--expected-destination <sha256>]
 *   bun src/helper/cli.ts disable --config <file> --vault <id>
 *
 * The packaged entry is `dist/helper/bin.js`, the same commands for Node (an app runs it as a separate
 * process, for example Electron with ELECTRON_RUN_AS_NODE=1); nothing of this file runs inside an app.
 *
 * `run` stays in the foreground until Ctrl-C, SIGTERM, SIGHUP or the required runtime bound, then stops.
 * Events are written to stderr as JSON lines; answers to `status` and `sync-now` go to stdout as JSON.
 * With a version 2 configuration (config.ts) it first checks the configured Git and gitleaks programs
 * (tools.ts; a refusal is exit 2) and runs every vault with the production options (production.ts):
 * those programs only, the configured credential helper only, and the GitHub visibility check.
 * There is deliberately no install, register or shutdown-over-socket command. `preview`, `enable` and
 * `disable` are one-shot commands for one vault of a version 2 configuration (enrol.ts), answered on
 * stdout as JSON: an app runs them only when its user turns backup on or off for that vault; `enable` exits
 * 1 when it refused.
 *
 * How `run` ends (exit code):
 * - 0: every cycle ended within grace + hard stop, every process the helper started is gone, the socket is
 *   removed and every claim released.
 * - 3: cancelled work did not end in time, a shutdown step failed, or the socket server failed while the
 *   helper ran (the `stop-failed` or `start-failed` event says which of work, socket and claims was established). The command killed every child process
 *   it owns and confirmed none was left (containment.ts), then exited; claims not released by then become
 *   reclaimable once this process is gone, which is after every writer has stopped. A Git command killed
 *   this way can leave a stale Git lock file behind.
 * - It does not exit while it cannot confirm that: a child survives SIGKILL, or the process list cannot be
 *   read. It keeps its claims and tries again, or, if the work ends and the claims are released, exits 0
 *   after a stop and 2 after a failed start.
 * - 2: the helper did not start (refused, or failed with all its work ended), or the arguments were wrong.
 *   Exit 0 only ever follows a helper that started.
 * Signal protection covers the whole run, from before the start begins until the run has ended: SIGINT,
 * SIGTERM and SIGHUP never end the process directly. The first asks the helper to stop (at once, or as soon
 * as the start completes); later ones are reported and ignored, so a second Ctrl-C cannot cut the order short.
 * The bound is the command's: grace + hard stop + the time containment needs, unless the process's own
 * event loop is blocked, in which case only an outside SIGKILL ends it.
 *
 * Extensions (`HelperExtensions`): a host's own helper entry may call `main`/`runCli` with trusted history
 * projections by name (production.ts). They come from that entry's code, never from configuration or
 * arguments. The generic entry (bin.ts) has none, so a vault that requires one is refused by every
 * command: `run` exits 2 before anything starts, `preview` reports the refusal and `enable` refuses.
 */
import { writeSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadHelperConfig } from "./config.ts";
import { connectHelper } from "./client.ts";
import { disableVault, enableVault, previewVault } from "./enrol.ts";
import { productionSharedOptions, productionVaultOptions, requiredProjection, resolveProductionConfig, type ProductionSeams } from "./production.ts";
import { sweepSync, type ContainmentResult } from "./containment.ts";
import { createProcessRegistry, type ProcessRegistry } from "./process-registry.ts";
import { runtimeSocketPath } from "./runtime-dir.ts";
import { HelperStartError, ShutdownError, startHelper, type HelperHandle, type StopResult } from "./server.ts";

const USAGE = "usage: cli.ts run --config <file> --runtime-dir <folder> --max-runtime-ms <ms> [--shutdown-grace-ms <ms>] [--hard-stop-ms <ms>] | status --runtime-dir <folder> [--vault <id>] | sync-now --runtime-dir <folder> --vault <id> | preview|disable --config <file> --vault <id> | enable --config <file> --vault <id> [--confirm-public] [--expected-destination <sha256>]";

/** What a host's own helper entry adds to the generic commands: trusted projections by name. */
export interface HelperExtensions {
  projections?: ProductionSeams["projections"];
  hostCredentials?: ProductionSeams["hostCredentials"];
  signal?: AbortSignal;
  maxRuntimeMs?: number;
}
export const EXIT_FORCED = 3;
/** Containment passes come this often at first, while killed children are being reaped... */
const FAST_PASS_MS = 20;
const FAST_WINDOW_MS = 5_000;
/** ...and then this often, until the work ends or a pass is confirmed. */
const SLOW_PASS_MS = 1_000;
/** A pass that stays unconfirmed is reported after this long (at once when the process list failed), then every REPORT_EVERY_MS. */
const REPORT_AFTER_MS = 1_000;
const REPORT_EVERY_MS = 5_000;

export interface ForegroundOptions {
  /** Writes one event line; synchronous so the last line is out before a forced exit. A failing write is ignored. */
  write?: (line: string) => void;
  /** Ends the process. The default is `process.exit`. */
  exit?: (code: number) => never;
  /** One containment pass. The default is `sweepSync` over the helper's process registry. */
  contain?: () => ContainmentResult;
}

const writeStderr = (line: string) => {
  writeSync(2, line);
};

/** Event output never decides what happens next: a write that fails (a closed pipe, say) is dropped. */
function eventWriter(options: ForegroundOptions): (event: Record<string, unknown>) => void {
  const write = options.write ?? writeStderr;
  return (event) => {
    try {
      write(`${JSON.stringify(event)}\n`);
    } catch {
      // Reporting cannot affect shutdown.
    }
  };
}

interface SignalGuard {
  /** Sets what the first signal does; a signal that came before this is applied now. */
  attach(stop: (signal: string) => void): void;
  dispose(): void;
}

/** Keeps SIGINT, SIGTERM and SIGHUP from ending the process until `dispose`. */
function guardSignals(event: (e: Record<string, unknown>) => void): SignalGuard {
  let stop: ((signal: string) => void) | null = null;
  let pending: string | null = null;
  let signalled = false;
  const onSignal = (signal: string) => {
    if (signalled) {
      event({ type: "signal-ignored", at: Date.now(), signal, reason: "already stopping" });
      return;
    }
    signalled = true;
    if (stop) stop(signal);
    else {
      pending = signal;
      event({ type: "stop-requested", at: Date.now(), signal, reason: "the helper stops as soon as its start has completed" });
    }
  };
  const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((signal) => {
    const fn = () => onSignal(signal);
    process.on(signal, fn);
    return () => process.off(signal, fn);
  });
  return {
    attach(fn) {
      stop = fn;
      if (pending !== null) fn(pending);
    },
    dispose() {
      for (const off of handlers) off();
    },
  };
}

/**
 * Work did not end on its own. Passes until one confirms that no owned child is left, then exits in the
 * same synchronous run. Until then it keeps running, and so holding the claims, unless the work ends first
 * and the claims are released normally; it then returns `endedCode` (0 after a stop, 2 after a failed
 * start). Never throws: a failed pass counts as unconfirmed.
 */
async function contain(released: Promise<void>, pass: () => ContainmentResult, options: ForegroundOptions, claimsReleased: boolean, endedCode: 0 | 2): Promise<number> {
  const event = eventWriter(options);
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let ended = false;
  let claims = claimsReleased ? "released" : "held until this process is gone";
  // Only a release counts as the work ending. A rejected one leaves containment to confirm instead, and
  // never settles this wake-up: every later pass still waits its interval.
  const settled = released.then(() => {
    ended = true;
  }, (error: unknown) => {
    if (error instanceof ShutdownError && error.report.claims === "released") claims = "released";
    return new Promise<void>(() => undefined);
  });
  const began = Date.now();
  const killed = new Set<number>();
  let reported = -Infinity;
  for (;;) {
    if (ended) return endedCode;
    let result: ContainmentResult;
    try {
      result = pass();
    } catch (error) {
      result = { confirmed: false, killed: [], remaining: [], listError: `containment failed: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}` };
    }
    for (const target of result.killed ?? []) killed.add(target);
    if (result.confirmed) {
      event({ type: "forced-exit", at: Date.now(), killed: [...killed], claims });
      return exit(EXIT_FORCED);
    }
    if ((result.listError !== undefined || Date.now() - began >= REPORT_AFTER_MS) && Date.now() - reported >= REPORT_EVERY_MS) {
      reported = Date.now();
      event({ type: "containment-incomplete", at: reported, remaining: result.remaining, ...(result.listError ? { listError: result.listError } : {}), claims });
    }
    const wait = Date.now() - began < FAST_WINDOW_MS ? FAST_PASS_MS : SLOW_PASS_MS;
    await Promise.race([settled, new Promise((r) => setTimeout(r, wait))]);
  }
}

async function foreground(handle: HelperHandle, options: ForegroundOptions, guard: SignalGuard): Promise<number> {
  guard.attach((signal) => void handle.stop(signal));
  let result: StopResult | null = null;
  try {
    result = await handle.outcome;
  } catch {
    // Not expected; whatever happened, nothing is known to have ended.
  }
  if (result?.state === "stopped") return 0;
  if (result?.state === "failed") eventWriter(options)({ type: "stop-failed", at: Date.now(), error: result.error, work: result.work, socket: result.socket, claims: result.claims });
  return contain(handle.done, options.contain ?? (() => sweepSync({ processes: handle.processes })), options, result?.state === "failed" && result.claims === "released", 0);
}

/**
 * After a failed start: one that did not end cleanly ("overdue" or "failed") is contained like an overdue
 * stop, and returns 3 after a confirmed pass or 2 if its work ends and the claims are released first.
 * Returns null for anything else, which the caller reports as not started (exit 2).
 */
export async function containFailedStart(error: unknown, fallback: ProcessRegistry, options: ForegroundOptions = {}): Promise<number | null> {
  if (!(error instanceof HelperStartError) || error.shutdown.state === "stopped") return null;
  const { shutdown } = error;
  eventWriter(options)({ type: "start-failed", at: Date.now(), message: error.message, shutdown: shutdown.state, ...(shutdown.state === "failed" ? { error: shutdown.error, work: shutdown.work, socket: shutdown.socket, claims: shutdown.claims } : {}) });
  const owned = error.processes ?? fallback;
  return contain(error.released, options.contain ?? (() => sweepSync({ processes: owned })), options, shutdown.state === "failed" && shutdown.claims === "released", 2);
}

/** Runs a started helper in the foreground until it stops, applying the exit policy above. */
export async function runForeground(handle: HelperHandle, options: ForegroundOptions = {}): Promise<number> {
  const guard = guardSignals(eventWriter(options));
  try {
    return await foreground(handle, options, guard);
  } finally {
    guard.dispose();
  }
}

export async function main(argv: string[], options: ForegroundOptions = {}, extensions: HelperExtensions = {}): Promise<number> {
  const projections = extensions.projections;
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    strict: true,
    options: {
      config: { type: "string" },
      "runtime-dir": { type: "string" },
      "max-runtime-ms": { type: "string" },
      "shutdown-grace-ms": { type: "string" },
      "hard-stop-ms": { type: "string" },
      vault: { type: "string" },
      "timeout-ms": { type: "string" },
      "confirm-public": { type: "boolean" },
      "expected-destination": { type: "string" },
    },
  });
  if (command === "preview" || command === "enable" || command === "disable") {
    if (!values.config || !values.vault) throw new Error(USAGE);
    const config = await loadHelperConfig(values.config);
    const processes = createProcessRegistry();
    const cancel = () => { void processes.end(); };
    extensions.signal?.addEventListener("abort", cancel, { once: true });
    if (extensions.signal?.aborted) cancel();
    const signalGuard = guardSignals(eventWriter(options));
    signalGuard.attach(cancel);
    const deps = { projections, hostCredentials: extensions.hostCredentials, launch: processes.launch };
    const expected = values["expected-destination"];
    try {
    const answer = command === "preview" ? await previewVault(config, values.vault, deps)
      : command === "enable" ? await enableVault(config, values.vault, { confirmPublic: values["confirm-public"] === true, ...(expected !== undefined ? { expectedDestinationDigest: expected } : {}) }, deps)
        : await disableVault(config, values.vault, deps);
    process.stdout.write(`${JSON.stringify(answer, null, 2)}\n`);
    return command === "enable" && !(answer as { enabled: boolean }).enabled ? 1 : 0;
    } finally {
      extensions.signal?.removeEventListener("abort", cancel);
      signalGuard.dispose();
      await processes.end();
    }
  }
  const runtimeDir = values["runtime-dir"];
  if (!runtimeDir) throw new Error(USAGE);
  const event = eventWriter(options);
  if (command === "run") {
    if (!values.config || !values["max-runtime-ms"]) throw new Error(USAGE);
    // A version 2 configuration runs only with the trusted programs and credential helper it names, as
    // their checked real paths; a refusal is exit 2.
    const config = await resolveProductionConfig(await loadHelperConfig(values.config));
    // A vault whose required history this entry cannot project never starts as documents only.
    for (const vault of config.vaults) requiredProjection(vault, projections);
    const processes = createProcessRegistry();
    // From here until the run has ended, a signal can only ask for a stop.
    const guard = guardSignals(event);
    const seal = () => processes.seal();
    extensions.signal?.addEventListener("abort", seal, { once: true });
    if (extensions.signal?.aborted) seal();
    try {
      let handle: HelperHandle;
      try {
        handle = await startHelper({
          config,
          runtimeDir,
          maxRuntimeMs: Math.min(Number(values["max-runtime-ms"]), extensions.maxRuntimeMs ?? Infinity),
          hostCredentials: extensions.hostCredentials,
          projections,
          shutdownGraceMs: values["shutdown-grace-ms"] === undefined ? undefined : Number(values["shutdown-grace-ms"]),
          hardStopMs: values["hard-stop-ms"] === undefined ? undefined : Number(values["hard-stop-ms"]),
          processes,
          ...(config.tools ? { engineOptions: productionSharedOptions(config)!, vaultEngineOptions: (vault) => vault.github?.credentialMode === "host" ? {} : productionVaultOptions(config, vault, processes.launch, projections ? { projections } : {}) } : {}),
          onEvent: (e) => event(e),
        });
      } catch (error) {
        // A start that did not end cleanly is contained like an overdue stop, under the same signal protection.
        guard.attach((signal) => event({ type: "signal-ignored", at: Date.now(), signal, reason: "already stopping" }));
        const code = await containFailedStart(error, processes, options);
        if (code === null) throw error;
        return code;
      }
      const cancel = () => { void handle.stop("host-lifetime"); };
      extensions.signal?.addEventListener("abort", cancel, { once: true });
      if (extensions.signal?.aborted) cancel();
      try { return await foreground(handle, options, guard); }
      finally { extensions.signal?.removeEventListener("abort", cancel); }
    } finally {
      extensions.signal?.removeEventListener("abort", seal);
      guard.dispose();
    }
  }
  if (command === "status" || command === "sync-now") {
    const timeoutMs = values["timeout-ms"] === undefined ? (command === "sync-now" ? 600_000 : 10_000) : Number(values["timeout-ms"]);
    const client = await connectHelper(runtimeSocketPath(runtimeDir), { client: "vault-sync-cli" });
    try {
      const response = command === "status"
        ? await client.request("status", values.vault ? { vault: values.vault } : {}, timeoutMs)
        : await client.request("syncNow", { vault: values.vault ?? "" }, timeoutMs);
      process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
      return response.ok ? 0 : 1;
    } finally {
      client.close();
    }
  }
  throw new Error(USAGE);
}

/** Runs one command and exits with its code; an error is reported on stderr and exits 2. */
export function runCli(argv: string[], extensions: HelperExtensions = {}): void {
  main(argv, {}, extensions).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(2);
    },
  );
}

// Only when Bun runs this source file itself; the packaged entry is bin.ts.
if (import.meta.main && import.meta.url.endsWith("/cli.ts")) runCli(process.argv.slice(2));
