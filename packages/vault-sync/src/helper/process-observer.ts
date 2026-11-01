/**
 * Read-only observation of a process incarnation on this host: is the process with this id and this exact
 * start time still there, gone, or unknown?
 *
 * The start time is the one the process table reports (`ps -o lstart= -p <pid>`, fixed locale, UTC),
 * parsed to epoch milliseconds: the same routine an app uses to record its own writer incarnation, so the
 * two readings compare exactly. Answers:
 * - "gone": no process has this id (`kill(pid, 0)` answers ESRCH). This is the only positive absence.
 * - "there": a process with this id started at exactly the recorded time.
 * - "unknown": anything else: another user's process, a start time that cannot be read or that differs from
 *   the recorded one by any amount, `ps` failing, not answering within OBSERVE_TIMEOUT_MS, or no new process
 *   allowed (the helper is stopping). The start time `ps` reports is derived from the wall clock, so a
 *   clock step changes the reading of the same live process; an unequal reading therefore cannot show that
 *   the id was reused, however large the difference.
 *
 * Callers act only on "gone" (release a write guard, accept a prior helper's absence); "unknown" keeps
 * every guard and refuses every handover. Nothing here signals a process: `kill(pid, 0)` sends no signal,
 * and the only process started is `ps`, through the helper's own launcher, so it is recorded and refused
 * once the helper is stopping.
 */
import type { ChildProcess } from "node:child_process";
import type { ProcessLauncher } from "../git-process.ts";

export type ProcessObservation = "there" | "gone" | "unknown";

export interface ProcessObserver {
  /** The process's start time in epoch ms from the process table, or null when it cannot be read in time. */
  startTime(pid: number): Promise<number | null>;
  /** Whether the process with `pid` that started at `startedAt` is still running. Settles within OBSERVE_TIMEOUT_MS. */
  observe(pid: number, startedAt: number): Promise<ProcessObservation>;
}

/** Longest wait for one observation. */
export const OBSERVE_TIMEOUT_MS = 2_000;
const MAX_PS_OUTPUT = 256;

/** Parses one `ps -o lstart=` line printed under LC_ALL=C and TZ=UTC ("Wed Oct  7 09:15:02 2026"). */
export function parseStartTime(text: string): number | null {
  const t = text.trim();
  if (!/^\w{3} +\w{3} +\d{1,2} +\d{2}:\d{2}:\d{2} +\d{4}$/.test(t)) return null;
  const ms = Date.parse(`${t} UTC`);
  return Number.isFinite(ms) ? ms : null;
}

/** The judgement from what was read; pure. `alive` is the kill(pid, 0) answer, `actual` the start time read. */
export function judge(alive: boolean | "unknown", recorded: number, actual: number | null): ProcessObservation {
  if (alive === false) return "gone";
  if (alive === "unknown" || actual === null) return "unknown";
  // A live process whose wall-derived start time reads differently may be the same one after a clock step.
  return actual === recorded ? "there" : "unknown";
}

function alive(pid: number): boolean | "unknown" {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: a process of another user holds this id; it is no process this user's app or helper started,
    // but it is not shown gone either.
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? false : "unknown";
  }
}

/** The production observer: `kill(pid, 0)` and `ps`, started through `launch`. */
export function createProcessObserver(launch: ProcessLauncher): ProcessObserver {
  const startTime = (pid: number): Promise<number | null> => {
    if (!Number.isSafeInteger(pid) || pid <= 1) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      let output = "";
      let child: ChildProcess;
      try {
        child = launch("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { env: { LC_ALL: "C", TZ: "UTC" }, stdio: ["ignore", "pipe", "ignore"] });
      } catch {
        resolve(null);
        return;
      }
      const settle = (value: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout?.removeAllListeners();
        child.removeAllListeners();
        child.on("error", () => undefined);
        resolve(value);
      };
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
        settle(null);
      }, OBSERVE_TIMEOUT_MS);
      child.stdout?.on("data", (chunk: Buffer) => {
        if (output.length < MAX_PS_OUTPUT) output += chunk.toString("utf8");
      });
      child.on("error", () => settle(null));
      child.on("close", (code) => settle(code === 0 ? parseStartTime(output) : null));
    });
  };
  return {
    startTime,
    async observe(pid, startedAt) {
      if (!Number.isSafeInteger(pid) || pid <= 1 || !Number.isSafeInteger(startedAt)) return "unknown";
      const first = alive(pid);
      if (first !== true) return judge(first, startedAt, null);
      return judge(true, startedAt, await startTime(pid));
    },
  };
}
