/**
 * What the helper itself establishes before the engine admits receipts: its own incarnation, the
 * activation attestation (exclusive ownership plus a quiescent prior helper) and gone-writer proofs.
 *
 * The engine checks shape and consistency under its record lock (receipt-transitions.ts); this module
 * supplies only facts the helper observed. Rules:
 * - Incarnation: `{host, pid, startedAt, helperVersion}` with `startedAt` read from the process table
 *   (process-observer.ts). Unreadable start time: no incarnation, so no attestation and no receipts.
 * - Exclusive: the caller attests only while it holds its runtime-folder claim and every vault claim and
 *   is not stopping, and only for a vault whose registered real path still resolves to itself, both
 *   checked again after the last await before the engine call (receipt-session.ts). The runtime-folder
 *   claim alone is not taken as excluding another helper for the same vault.
 * - Prior helper: when the record names another activated helper, a handover is accepted only on the
 *   exact helper's own sealed shutdown report (work ended, claims released, socket clean), and absence
 *   only on an observation that no process has its pid, on this host (process-observer.ts: a live
 *   process with another start time is unknown, never gone). "there", "unknown", a read failure, a
 *   timeout or another host refuses.
 * - Gone writers: proofs are built only for this client's tagged marks whose writer is not the session's
 *   own, on this host, observed gone the same way; each names the exact path, writer and mark generation,
 *   so the engine releases nothing else. Unknown keeps the guard.
 *
 * Which helper holds activation and which marks exist is read from deadline.json without a lock, with the
 * engine's own parser, as a hint only: the engine re-checks every attestation and proof under the record
 * lock, so a stale hint is refused (activation) or releases nothing (proofs). The engine's receipt API has
 * no read of these two facts; this read never writes.
 */
import { readFile, realpath } from "node:fs/promises";
import { parseRecordDetailed } from "../deadline.ts";
import { isHelper, isTaggedOwner, ledgerOf, sameHelper, sameWriter, type HelperIncarnation, type TaggedWriteOwner, type WriterIncarnation } from "../receipt-ledger.ts";
import type { ActivationAttestation, GoneWriterProof } from "../receipt-transitions.ts";
import { OBSERVE_TIMEOUT_MS, type ProcessObservation, type ProcessObserver } from "./process-observer.ts";
import type { ShutdownReport } from "./server.ts";

/** A prior helper's own shutdown report, kept by whoever ran it. Only a sealed one allows a handover. */
export interface PriorShutdownEvidence {
  by: HelperIncarnation;
  report: ShutdownReport;
}

export interface RecordHint {
  activation: HelperIncarnation | null;
  marks: Array<{ path: string; gen: number; owner: TaggedWriteOwner }>;
}

/** Activation holder and active tagged marks from an unlocked read; null when the record cannot be read or interpreted. */
export async function readRecordHint(recordFile: string): Promise<RecordHint | null> {
  let text: string;
  try {
    text = await readFile(recordFile, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { activation: null, marks: [] } : null;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = parseRecordDetailed(value);
  if (!parsed || parsed.kind !== "ok") return null;
  const by = ledgerOf(parsed.record)?.activation?.by ?? null;
  const marks: RecordHint["marks"] = [];
  for (const [path, mark] of Object.entries(parsed.record.writes)) {
    if (mark.active && mark.owner !== undefined && isTaggedOwner(mark.owner)) marks.push({ path, gen: mark.gen, owner: mark.owner });
  }
  return { activation: by && isHelper(by) ? { ...by } : null, marks };
}

/** Races an observation against OBSERVE_TIMEOUT_MS; a late or failing observer answers "unknown". */
export function boundedObserve(observer: ProcessObserver, pid: number, startedAt: number): Promise<ProcessObservation> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("unknown"), OBSERVE_TIMEOUT_MS);
    observer.observe(pid, startedAt).then(
      (answer) => {
        clearTimeout(timer);
        resolve(answer === "there" || answer === "gone" ? answer : "unknown");
      },
      () => {
        clearTimeout(timer);
        resolve("unknown");
      },
    );
  });
}

/**
 * This helper's incarnation, read once and kept; an unreadable start time is not kept, so the next caller
 * asks again. The read is bounded like an observation.
 */
export function helperIncarnation(observer: ProcessObserver, host: string, helperVersion: string, pid: number = process.pid): () => Promise<HelperIncarnation | null> {
  let known: HelperIncarnation | null = null;
  let asking: Promise<HelperIncarnation | null> | null = null;
  return () => {
    if (known) return Promise.resolve(known);
    asking ??= new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), OBSERVE_TIMEOUT_MS);
      observer.startTime(pid).then((t) => { clearTimeout(timer); resolve(t); }, () => { clearTimeout(timer); resolve(null); });
    }).then((startedAt) => {
      asking = null;
      const self = { host, pid, startedAt: startedAt ?? -1, helperVersion };
      if (startedAt === null || !Number.isSafeInteger(startedAt) || startedAt < 0 || !isHelper(self)) return null;
      known = self;
      return known;
    });
    return asking;
  };
}

/** True when the registered vault path is still its own real path (not replaced by a link or moved). */
export async function canonicalRegistration(path: string): Promise<boolean> {
  try {
    return (await realpath(path)) === path;
  } catch {
    return false;
  }
}

/** A shutdown report that proves the prior helper's work ended and its claims were released. */
export function sealed(report: ShutdownReport): boolean {
  const socketClean = report.socket === "removed" || report.socket === "absent" || report.socket === "replaced" || report.socket === "not-created";
  return report.work === "ended" && report.claims === "released" && socketClean;
}

/**
 * The attestation for this helper, given the activation holder the record names (`hint`). Exclusivity and
 * registration are the caller's to establish first.
 */
export async function attest(self: HelperIncarnation, holder: HelperIncarnation | null, evidence: PriorShutdownEvidence | null, observer: ProcessObserver): Promise<{ attestation: ActivationAttestation } | { refused: string }> {
  if (holder === null || sameHelper(holder, self)) return { attestation: { helper: { ...self }, exclusive: true, prior: null } };
  if (evidence && sameHelper(evidence.by, holder) && sealed(evidence.report)) {
    return { attestation: { helper: { ...self }, exclusive: true, prior: { by: { ...holder }, quiescence: "handover" } } };
  }
  if (holder.host !== self.host) return { refused: "another helper on another host holds receipt activation; its absence cannot be observed here" };
  const seen = await boundedObserve(observer, holder.pid, holder.startedAt);
  if (seen === "gone") return { attestation: { helper: { ...self }, exclusive: true, prior: { by: { ...holder }, quiescence: "gone" } } };
  return { refused: seen === "there" ? "the helper holding receipt activation is still running" : "whether the helper holding receipt activation has ended cannot be established" };
}

/** Exact proofs for this client's prior writers observed gone on this host; anything not shown gone is left out. */
export async function goneWriterProofs(hint: RecordHint, clientId: string, writer: WriterIncarnation | null, self: HelperIncarnation, observer: ProcessObserver, now: () => number): Promise<GoneWriterProof[]> {
  const candidates = hint.marks.filter((m): m is { path: string; gen: number; owner: Extract<TaggedWriteOwner, { clientId: string }> } =>
    !("unknown" in m.owner) && m.owner.clientId === clientId && m.owner.writer.host === self.host && (writer === null || !sameWriter(m.owner.writer, writer)));
  const seen = new Map<string, Promise<ProcessObservation>>();
  const look = (w: WriterIncarnation) => {
    const key = `${w.pid}:${w.startedAt}`;
    let answer = seen.get(key);
    if (!answer) seen.set(key, (answer = boundedObserve(observer, w.pid, w.startedAt)));
    return answer;
  };
  const answers = await Promise.all(candidates.map((m) => look(m.owner.writer)));
  const proofs: GoneWriterProof[] = [];
  candidates.forEach((m, i) => {
    if (answers[i] === "gone") proofs.push({ path: m.path, writer: { ...m.owner.writer }, markGen: m.gen, checkedAt: now() });
  });
  return proofs;
}
