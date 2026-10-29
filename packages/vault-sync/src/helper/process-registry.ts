/**
 * Ownership of the helper's native processes, established when each one starts and kept after its command
 * has ended.
 *
 * Every Git and scanner process the helper's engines start goes through `launch` (the engine's
 * `ProcessLauncher` seam). It starts the process as the leader of a new session and process group
 * (`detached`, which is setsid on POSIX) and records that group before returning. At that moment the
 * leader exists and has not been reaped, so the group id cannot belong to anything else.
 *
 * A group stays recorded until it is proven empty: `kill(-group, 0)` answers ESRCH. Every other answer keeps
 * it: success (a member is alive) and EPERM (on macOS this is what a group whose only member is an unreaped
 * zombie answers; it is also the answer for a member running as another user). So a command that has
 * closed but left a process behind in its group, such as a background writer reparented to launchd, is
 * still owned; parent ancestry plays no part.
 *
 * `seal` makes every later `launch` throw, which the engine reports as a failed start (Git: kind "spawn";
 * scanner: unavailable, so the push is held back). Once sealed, no new process can join what is being ended.
 *
 * Bounds, chosen deliberately:
 * - A process that leaves its group (setsid, or setpgid to another group) is no longer covered by its record.
 *   The programs launched here are fixed: Git, with hooks, the file-system monitor, automatic maintenance,
 *   repository and user credential helpers and every transport except file and HTTPS disabled (the helper
 *   names no trusted credential helper), and gitleaks. Nothing the engine asks of either starts a daemon.
 *   The command line's census (containment.ts) still catches such a process while it is a descendant.
 * - A group id can be reused only after the group is empty. A recorded id is checked when its leader is
 *   reaped (`exit`) and then every second while it stays recorded; a stale id could be signalled only if,
 *   between two checks, its last member ended, process ids wrapped round to exactly that number and the new
 *   process made itself a group leader. With sequential ids up to 99 999 that is about 100 000 process starts
 *   within one second.
 */
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import type { ProcessLauncher } from "../git-process.ts";

const PRUNE_MS = 1_000;
const END_POLL_MS = 20;

export interface ProcessRegistry {
  /** Starts a process as the leader of its own group and records the group. Throws once sealed. */
  readonly launch: ProcessLauncher;
  /** Refuses every later launch. */
  seal(): void;
  readonly sealed: boolean;
  /** Recorded groups not yet proven empty, checked now; groups proven empty are forgotten. */
  live(): number[];
  /** Sends SIGKILL to every recorded group not yet proven empty and returns those signalled. */
  killLive(): number[];
  /**
   * Seals, then kills every recorded group and waits until each is proven empty, killing again on every
   * poll. Never rejects; it does not resolve while a member survives SIGKILL.
   */
  end(): Promise<void>;
}

/** True once no process is left in `group`. */
function groupGone(group: number): boolean {
  try {
    process.kill(-group, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

export function createProcessRegistry(): ProcessRegistry {
  if (process.platform === "win32") throw new Error("the helper's process ownership needs POSIX process groups");
  const groups = new Set<number>();
  let sealed = false;
  let pruner: ReturnType<typeof setInterval> | null = null;

  const prune = () => {
    for (const group of groups) if (groupGone(group)) groups.delete(group);
    if (groups.size === 0 && pruner !== null) {
      clearInterval(pruner);
      pruner = null;
    }
  };

  const live = () => {
    prune();
    return [...groups];
  };

  const killLive = () => {
    const signalled: number[] = [];
    for (const group of live()) {
      try {
        process.kill(-group, "SIGKILL");
        signalled.push(group);
      } catch {
        // Ended between the check and the signal.
      }
    }
    return signalled;
  };

  const launch: ProcessLauncher = (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
    if (sealed) throw new Error("the helper is stopping: no new process may start");
    const child = spawn(command, args, { ...options, detached: true });
    const group = child.pid;
    if (typeof group === "number" && group > 1) {
      groups.add(group);
      child.once("exit", prune);
      if (pruner === null) {
        pruner = setInterval(prune, PRUNE_MS);
        pruner.unref?.();
      }
    }
    return child;
  };

  return {
    launch,
    seal: () => {
      sealed = true;
    },
    get sealed() {
      return sealed;
    },
    live,
    killLive,
    async end() {
      sealed = true;
      for (;;) {
        killLive();
        if (groups.size === 0) return;
        await new Promise((r) => setTimeout(r, END_POLL_MS));
      }
    },
  };
}
