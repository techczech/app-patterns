/**
 * Last-resort containment for the foreground command line, used only when work this process started has not
 * ended on its own: `stop()` answered "overdue", or a failed start left work running.
 *
 * Work inside this process ends when the process ends. Work in child processes does not, so the command
 * line may exit only once every child process it owns is confirmed gone. One `sweepSync` pass:
 *
 * 1. Seals the process registry, so no new Git or scanner process can start.
 * 2. Checks every process group recorded at launch (process-registry.ts). These cover each native Git and
 *    scanner process and anything left in their groups after the command itself closed, whoever its parent
 *    now is.
 * 3. Lists processes (`ps`) as a supplement, for children started some other way: every live descendant of
 *    this process, and the members of each group a descendant leads.
 * 4. If nothing is alive and the listing succeeded, the pass is confirmed. Otherwise it sends SIGKILL to
 *    what it found and is not confirmed. A failed listing is never confirmed.
 *
 * Confirmation needs a later pass: a killed child stays a zombie until this process's event loop reaps it,
 * and on macOS a group holding only a zombie still answers as present. So the caller kills, yields, and
 * passes again; it exits only in the same synchronous run as a confirmed pass, so no callback can start new
 * work in between.
 *
 * Never signalled: this process, its own group, and groups that neither the registry recorded nor a
 * descendant leads (so not the parent's or the terminal's group). Process ids seen in a listing are signalled
 * within the same pass, microseconds later; reuse in that window is not guarded against.
 */
import { execFileSync } from "node:child_process";
import type { ProcessRegistry } from "./process-registry.ts";

export interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  zombie: boolean;
}

export interface ContainmentResult {
  /** True only when no owned process was alive and the process listing succeeded. */
  confirmed: boolean;
  /** Processes and groups (negative) sent SIGKILL in this pass. */
  killed: number[];
  /** Owned processes and groups (negative) found alive in this pass. */
  remaining: number[];
  /** Why the process listing failed, when it did. */
  listError?: string;
}

export interface SweepOptions {
  processes: ProcessRegistry;
  rootPid?: number;
  /** Process listing. Default `listProcessesSync`. */
  list?: () => ProcessRow[];
  /** Signals a pid (or a group, negative). Default `process.kill`. Test seam. */
  kill?: (target: number, signal: NodeJS.Signals | 0) => void;
}

/** Lists processes with `ps`; synchronous so the caller can act on the answer before any callback runs. Throws on failure. */
export function listProcessesSync(): ProcessRow[] {
  const out = execFileSync("/bin/ps", ["-A", "-o", "pid=,ppid=,pgid=,stat="], { encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024 * 1024 });
  const rows: ProcessRow[] = [];
  for (const line of out.split("\n")) {
    const [pid, ppid, pgid, stat] = line.trim().split(/\s+/);
    if (!pid || !ppid || !pgid || !stat) continue;
    rows.push({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), zombie: stat.startsWith("Z") });
  }
  return rows;
}

/** One containment pass (see above). Never throws. */
export function sweepSync(options: SweepOptions): ContainmentResult {
  const root = options.rootPid ?? process.pid;
  const kill = options.kill ?? ((target: number, signal: NodeJS.Signals | 0) => void process.kill(target, signal));
  const exists = (pid: number) => {
    try {
      kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  };
  const groups = new Set<number>();
  const pids = new Set<number>();
  let listError: string | undefined;
  try {
    options.processes.seal();
    for (const group of options.processes.live()) groups.add(group);
    const rows = (options.list ?? listProcessesSync)();
    const rootGroup = rows.find((r) => r.pid === root)?.pgid ?? null;
    const children = new Map<number, ProcessRow[]>();
    for (const row of rows) {
      const siblings = children.get(row.ppid);
      if (siblings) siblings.push(row);
      else children.set(row.ppid, [row]);
    }
    const descendants: ProcessRow[] = [];
    const seen = new Set<number>([root]);
    const stack = [root];
    while (stack.length) {
      for (const child of children.get(stack.pop()!) ?? []) {
        if (seen.has(child.pid)) continue;
        seen.add(child.pid);
        descendants.push(child);
        stack.push(child.pid);
      }
    }
    // A group counts as owned when a descendant leads it; members of an owned group may have other parents.
    const led = new Set(descendants.filter((d) => d.pgid === d.pid && d.pgid > 1 && d.pgid !== rootGroup).map((d) => d.pgid));
    for (const row of rows) {
      if (row.pid === root || row.zombie) continue;
      if (seen.has(row.pid) || led.has(row.pgid)) pids.add(row.pid);
    }
    for (const group of led) groups.add(group);
    // `ps` was itself a child while it ran; it and anything else already gone drop out here.
    for (const pid of pids) if (!exists(pid)) pids.delete(pid);
  } catch (error) {
    listError = error instanceof Error ? error.message.slice(0, 300) : String(error);
  }
  const remaining = [...[...groups].map((g) => -g), ...pids];
  if (remaining.length === 0 && listError === undefined) return { confirmed: true, killed: [], remaining: [] };
  const killed: number[] = [];
  for (const target of remaining) {
    try {
      kill(target, "SIGKILL");
      killed.push(target);
    } catch {
      // Already gone, or a group holding only a zombie; the next pass checks again.
    }
  }
  return { confirmed: false, killed, remaining, ...(listError === undefined ? {} : { listError }) };
}
