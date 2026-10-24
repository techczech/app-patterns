/**
 * The deadline record: every edit the engine knows about that is not yet in a verified remote snapshot,
 * and the time the oldest of them was made. Only verification resolves an edit; capture, push failures,
 * restarts and elapsed time never do.
 *
 * Order comes from the record's own generation counter, never from clock readings. Every report (edit,
 * write start, save acknowledgement) takes the next generation under the record lock, and a capture notes
 * the generation of the record it read before reading any file. Times are kept only to measure how old an
 * edit is: an equal or rolled-back clock changes an age, never which save or capture came first.
 *
 * An edit moves through these states, each kept with the earliest edit time it stands for:
 * - unflushed: reported with `noteEdit`, which returns the edit's ticket (its generation). A report names
 *   one document path, or none (a vault-wide edit). Nothing the engine reads from disk resolves it.
 * - flushed: a save acknowledgement (`noteFlush`) covered it. An acknowledgement names the newest ticket
 *   its saved bytes contain and either the paths it saved or all documents. Naming paths covers only edits
 *   reported for those paths with that ticket or an earlier one; only an all-documents acknowledgement
 *   covers vault-wide edits. A capture that started after the acknowledgement and read the path (or
 *   confirmed it deleted) captures it; a vault-wide one needs a capture that left nothing pending and
 *   listed every folder in scope.
 * - captured: in snapshot number `seq` of this checkout's chain. Verifying that snapshot, or a later one,
 *   resolves it.
 * A file a capture could not read keeps a floor in `pendingSince`, and a folder in scope it could not list
 * keeps one in `unlistedSince`, until a capture reads it. The floor is the start of the capture before
 * (the last time the engine looked), because the change may have been made any time since. Coordinated
 * in-place writes are marked in `writes` with the generation of their last start or end, so a capture can
 * tell that a write began or finished while it was reading.
 *
 * Times are milliseconds since the epoch.
 */
import type { BackupBlock } from "./blocks.ts";

export type EditTicket = number;
/** Generation returned by a coordinated write start; valid only in its checkout. */
export type WriteToken = number;

export interface SnapshotCoverage {
  snapshot: string;
  ref: string;
  /** Position of the snapshot in this checkout's chain; null when the engine did not record its capture. */
  seq: number | null;
  /** Capture start time; null when unknown. */
  coverage: number | null;
}

export interface UnflushedEdits {
  /** Document path, or null for edits reported without one (vault-wide). */
  path: string | null;
  /** Earliest edit time in the range. */
  from: number;
  /** Tickets of the earliest and newest edit in the range. */
  first: EditTicket;
  last: EditTicket;
}

export interface FlushedEdit {
  path: string | null;
  from: number;
  /** Generation of the save acknowledgement. */
  ackGen: number;
}

export interface CapturedEdit {
  seq: number;
  from: number;
}

export interface WriteMark {
  /** Generation of the write's last start or end. */
  gen: number;
  active: boolean;
  /** Time the write started (age only). */
  since: number;
}

export interface BackupErrorRecord {
  kind: "push-rejected" | "push-failed" | "verify-failed" | "verify-mismatch" | "capture-failed";
  at: number;
  message: string;
}

export interface DeadlineRecord {
  schema: 3;
  /** Last generation handed out; grows by one with every report. */
  generation: number;
  /** Derived: the earliest edit time held in any state below; null when nothing is outstanding. */
  oldestUnprotectedEdit: number | null;
  latestEditNoted: number | null;
  unflushed: UnflushedEdits[];
  flushed: FlushedEdit[];
  captured: CapturedEdit[];
  writes: Record<string, WriteMark>;
  /** File path -> floor, kept while captures cannot read it. */
  pendingSince: Record<string, number>;
  /** Folder path ("" for the worktree root) -> floor, kept while captures cannot list it. */
  unlistedSince: Record<string, number>;
  snapshotSeq: number;
  lastVerifiedSnapshot: string | null;
  lastVerifiedAt: number | null;
  /** Every edit made before this time is in a verified snapshot. */
  protectedThrough: number | null;
  lastCapture: SnapshotCoverage | null;
  lastPushed: SnapshotCoverage | null;
  lastError: BackupErrorRecord | null;
  /** Set when the record was converted from an older schema or replaced a damaged one. */
  recoveredFromDamagedRecord?: boolean;
  /** Schema of the record this one was converted from; "damaged" when it could not be read. */
  convertedFrom?: number | "damaged";
  /** Why the last push was held back (visibility, secret scan, remote set-up); cleared by the next successful push. */
  lastBlock?: BackupBlock | null;
}

const MAX_UNFLUSHED = 1024;
const MAX_FLUSHED = 1024;
const MAX_CAPTURED = 256;

export function emptyRecord(): DeadlineRecord {
  return {
    schema: 3,
    generation: 0,
    oldestUnprotectedEdit: null,
    latestEditNoted: null,
    unflushed: [],
    flushed: [],
    captured: [],
    writes: {},
    pendingSince: {},
    unlistedSince: {},
    snapshotSeq: 0,
    lastVerifiedSnapshot: null,
    lastVerifiedAt: null,
    protectedThrough: null,
    lastCapture: null,
    lastPushed: null,
    lastError: null,
  };
}

const min = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.min(a, b));
const max = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));

/** Earliest edit time not yet in a snapshot: what a snapshot taken now cannot claim to hold. */
function oldestUncaptured(record: DeadlineRecord): number | null {
  let oldest: number | null = null;
  for (const u of record.unflushed) oldest = min(oldest, u.from);
  for (const f of record.flushed) oldest = min(oldest, f.from);
  for (const t of Object.values(record.pendingSince)) oldest = min(oldest, t);
  for (const t of Object.values(record.unlistedSince)) oldest = min(oldest, t);
  for (const w of Object.values(record.writes)) if (w.active) oldest = min(oldest, w.since);
  return oldest;
}

function withOldest(record: DeadlineRecord): DeadlineRecord {
  let oldest = oldestUncaptured(record);
  for (const c of record.captured) oldest = min(oldest, c.from);
  return { ...record, oldestUnprotectedEdit: oldest, recoveredFromDamagedRecord: oldest === null ? undefined : record.recoveredFromDamagedRecord };
}

function finite(time: number, what: string): number {
  if (!Number.isFinite(time)) throw new Error(`${what} must be a finite number of milliseconds`);
  return time;
}

/** An edit made at `time` (age only) to `path`, or vault-wide when null, that may not be on disk yet. */
export function noteEdit(record: DeadlineRecord, time: number, path: string | null): { record: DeadlineRecord; ticket: EditTicket } {
  finite(time, "edit time");
  const ticket = record.generation + 1;
  let unflushed = record.unflushed.map((u) => ({ ...u }));
  const same = unflushed.find((u) => u.path === path);
  if (same) {
    same.from = Math.min(same.from, time);
    same.last = ticket;
  } else {
    unflushed.push({ path, from: time, first: ticket, last: ticket });
  }
  while (unflushed.length > MAX_UNFLUSHED) {
    // Folding a document's range into the vault-wide one is conservative: only an all-documents
    // acknowledgement can then cover it.
    const index = unflushed.findIndex((u) => u.path !== null);
    const [folded] = unflushed.splice(index, 1) as [UnflushedEdits];
    const wide = unflushed.find((u) => u.path === null);
    if (wide) {
      wide.from = Math.min(wide.from, folded.from);
      wide.first = Math.min(wide.first, folded.first);
      wide.last = Math.max(wide.last, folded.last);
    } else {
      unflushed = [...unflushed, { ...folded, path: null }];
    }
  }
  return { record: withOldest({ ...record, generation: ticket, unflushed, latestEditNoted: max(record.latestEditNoted, time) }), ticket };
}

/** A coordinated writer starts writing these paths in place at `at`; captures keep their previous version. */
export function noteWriteStart(record: DeadlineRecord, paths: readonly string[], at: number): DeadlineRecord {
  finite(at, "write start");
  const gen = record.generation + 1;
  if (paths.some((path) => record.writes[path]?.active)) throw new Error("a coordinated write is already active on a named path");
  const writes = { ...record.writes };
  for (const path of paths) writes[path] = { gen, active: true, since: at };
  return withOldest({ ...record, generation: gen, writes });
}

export interface WriteCompletion {
  path: string;
  token: WriteToken;
}

export type FlushAcknowledgement = {
  /** Only these exact path/start identities may end active coordinated writes. Omit for atomic saves. */
  completedWrites?: readonly WriteCompletion[];
} & (
  /** The bytes of these paths are durable and contain every edit reported for them with ticket `upTo` or earlier. */
  | { upTo: EditTicket; paths: readonly string[]; allDocuments?: undefined }
  /** Every document is durable and contains every edit reported with ticket `upTo` or earlier, vault-wide ones included. */
  | { upTo: EditTicket; allDocuments: true; paths?: undefined });

function addFlushed(flushed: FlushedEdit[], entry: FlushedEdit): FlushedEdit[] {
  const same = flushed.find((f) => f.path === entry.path);
  if (same) {
    // Merging waits for the later acknowledgement; the earlier edit time keeps the age.
    same.from = Math.min(same.from, entry.from);
    same.ackGen = Math.max(same.ackGen, entry.ackGen);
    return flushed;
  }
  let next = [...flushed, entry];
  while (next.length > MAX_FLUSHED) {
    // Folding into a vault-wide entry is conservative: it then needs a complete capture.
    const index = next.findIndex((f) => f.path !== null);
    const [folded] = next.splice(index, 1) as [FlushedEdit];
    next = addFlushed(next, { ...folded, path: null });
  }
  return next;
}

/** A save acknowledgement, recorded at engine time `at`. Throws for a ticket the record never handed out. */
export function noteFlush(record: DeadlineRecord, ack: FlushAcknowledgement, at: number): DeadlineRecord {
  finite(at, "acknowledgement time");
  if (!Number.isSafeInteger(ack.upTo) || ack.upTo < 0 || ack.upTo > record.generation) throw new Error("upTo must be a ticket returned by noteEdit for this folder (or 0)");
  if (ack.completedWrites !== undefined && !Array.isArray(ack.completedWrites)) throw new Error("completedWrites must be an array of path/token receipts");
  for (const receipt of ack.completedWrites ?? []) {
    if (!receipt || typeof receipt.path !== "string" || !Number.isSafeInteger(receipt.token) || receipt.token <= 0 || receipt.token > record.generation) throw new Error("write completion must name a path and a token returned by noteWriteStart");
  }
  const all = ack.allDocuments === true;
  if (!all && (!Array.isArray(ack.paths) || ack.paths.length === 0)) throw new Error("a save acknowledgement names the saved paths, or sets allDocuments for a save of every document");
  const named = new Set(ack.paths ?? []);
  const covers = (path: string | null) => all || (path !== null && named.has(path));
  const ackGen = record.generation + 1;
  let flushed = record.flushed.map((f) => ({ ...f }));
  const unflushed: UnflushedEdits[] = [];
  for (const u of record.unflushed) {
    if (!covers(u.path) || u.first > ack.upTo) {
      unflushed.push(u);
      continue;
    }
    flushed = addFlushed(flushed, { path: u.path, from: u.from, ackGen });
    // Later edits on the same path stay unflushed; their own times are not kept, so the range's earliest
    // time stays their conservative floor.
    if (u.last > ack.upTo) unflushed.push({ ...u, first: ack.upTo + 1 });
  }
  const writes = { ...record.writes };
  for (const [path, mark] of Object.entries(writes)) {
    // Edit tickets describe saved edits, not write intervals. A delayed/replayed save can only end
    // the interval it actually completed, even when it names all documents or the clock moves back.
    if (!mark.active || !covers(path) || !ack.completedWrites?.some((receipt) => receipt.path === path && receipt.token === mark.gen)) continue;
    // The write's own bytes still need a capture, from the time it started.
    writes[path] = { gen: ackGen, active: false, since: mark.since };
    flushed = addFlushed(flushed, { path, from: mark.since, ackGen });
  }
  return withOldest({ ...record, generation: ackGen, unflushed, flushed, writes });
}

export interface CaptureOutcome {
  snapshot: string;
  ref: string;
  startedAt: number;
  /** Generation of the record the capture read before reading any file. */
  startGen: number;
  /** Floor for files and folders first found pending: the previous capture's start (or this one's). */
  pendingFloor: number;
  /** True when this capture made a new snapshot commit. */
  committed: boolean;
  /** True if the capture found any difference from the previous snapshot on disk. */
  sawChange: boolean;
  /** Paths read stably and kept (changed or not). */
  readPaths: readonly string[];
  /** Paths in scope confirmed absent from disk (exact deletion coverage). */
  goneConfirmed: readonly string[];
  /** Paths left at their previous version (unstable, unreadable, too large, in an unreadable folder, being written). */
  pendingPaths: readonly string[];
  /** Paths whose pending marks no longer apply (removed from disk or scope). */
  clearedPaths: readonly string[];
  /** Folders in scope that could not be listed (still unknown). */
  unlistedFolders: readonly string[];
  /** Folders that were unlisted before and were listed by this capture. */
  relistedFolders: readonly string[];
}

function settlePending(record: DeadlineRecord, outcome: Omit<CaptureOutcome, "snapshot" | "ref">, add: (from: number) => void) {
  const pendingSince = { ...record.pendingSince };
  const pendingSet = new Set(outcome.pendingPaths);
  for (const path of [...outcome.readPaths, ...outcome.goneConfirmed]) {
    const since = pendingSince[path];
    if (since !== undefined && !pendingSet.has(path)) {
      add(since);
      delete pendingSince[path];
    }
  }
  for (const path of outcome.clearedPaths) delete pendingSince[path];
  for (const path of outcome.pendingPaths) pendingSince[path] ??= outcome.pendingFloor;
  const unlistedSince: Record<string, number> = {};
  for (const folder of outcome.unlistedFolders) unlistedSince[folder] = record.unlistedSince[folder] ?? outcome.pendingFloor;
  for (const folder of outcome.relistedFolders) {
    const since = record.unlistedSince[folder];
    if (since !== undefined) add(since);
  }
  // Writes that ended before this capture read the record are no longer needed for comparison.
  const writes: Record<string, WriteMark> = {};
  for (const [path, mark] of Object.entries(record.writes)) if (mark.active || mark.gen > outcome.startGen) writes[path] = mark;
  return { pendingSince, unlistedSince, writes };
}

/** Pending marks from a capture that produced no snapshot (nothing could be committed yet). */
export function markPending(record: DeadlineRecord, outcome: Omit<CaptureOutcome, "snapshot" | "ref">): DeadlineRecord {
  // With no snapshot nothing is captured: earlier marks stay, new ones are added.
  const settled = settlePending(record, { ...outcome, readPaths: [], committed: false, sawChange: false }, () => undefined);
  for (const folder of outcome.relistedFolders) {
    const since = record.unlistedSince[folder];
    if (since !== undefined) settled.unlistedSince[folder] = since;
  }
  return withOldest({ ...record, ...settled });
}

/** Next snapshot number for a capture that produced `snapshot`. */
function seqFor(record: DeadlineRecord, snapshot: string, committed: boolean): number {
  const last = record.lastCapture;
  if (!committed && last && last.snapshot === snapshot && last.seq !== null) return last.seq;
  return record.snapshotSeq + 1;
}

/** The capture's settled record, and the coverage claim its snapshot can carry: every edit before it is in the snapshot. */
export function applyCapture(record: DeadlineRecord, outcome: CaptureOutcome): { record: DeadlineRecord; coverageThrough: number } {
  const seq = seqFor(record, outcome.snapshot, outcome.committed);
  const captured = record.captured.map((c) => ({ ...c }));
  const add = (from: number) => {
    const same = captured.find((c) => c.seq === seq);
    if (same) same.from = Math.min(same.from, from);
    else captured.push({ seq, from });
  };
  const settled = settlePending(record, outcome, add);
  if (outcome.sawChange) add(outcome.startedAt);

  const pendingSet = new Set(outcome.pendingPaths);
  const accounted = new Set([...outcome.readPaths, ...outcome.goneConfirmed]);
  for (const path of pendingSet) accounted.delete(path);
  const complete = pendingSet.size === 0 && outcome.unlistedFolders.length === 0;
  const flushed: FlushedEdit[] = [];
  for (const f of record.flushed) {
    const covered = f.ackGen <= outcome.startGen && (f.path === null ? complete : accounted.has(f.path));
    if (covered) add(f.from);
    else flushed.push(f);
  }
  captured.sort((a, b) => a.seq - b.seq);
  while (captured.length > MAX_CAPTURED) {
    // Merging into the later snapshot is conservative: it resolves only when that one is verified.
    const [a, b] = captured as [CapturedEdit, CapturedEdit];
    captured.splice(0, 2, { seq: b.seq, from: Math.min(a.from, b.from) });
  }
  const next = withOldest({
    ...record,
    ...settled,
    flushed,
    captured,
    snapshotSeq: Math.max(record.snapshotSeq, seq),
    lastCapture: { snapshot: outcome.snapshot, ref: outcome.ref, seq, coverage: outcome.startedAt },
  });
  return { record: next, coverageThrough: min(outcome.startedAt, oldestUncaptured(next))! };
}

/** Coverage a capture's snapshot can claim, computed before its commit exists (the snapshot id does not affect it). */
export function coverageOfCapture(record: DeadlineRecord, outcome: Omit<CaptureOutcome, "snapshot" | "ref">): number {
  return applyCapture(record, { ...outcome, snapshot: "", ref: "" }).coverageThrough;
}

export function applyPushed(record: DeadlineRecord, snapshot: string, ref: string): DeadlineRecord {
  const capture = record.lastCapture;
  const pushed: SnapshotCoverage = capture && capture.snapshot === snapshot
    ? { ...capture, ref }
    : { snapshot, ref, seq: null, coverage: null };
  return { ...record, lastPushed: pushed, lastError: null, lastBlock: null };
}

/** Applied only after the backup destination showed the ref at exactly the pushed object id. */
export function applyVerified(record: DeadlineRecord, verified: SnapshotCoverage, at: number): DeadlineRecord {
  const base = { ...record, lastVerifiedSnapshot: verified.snapshot, lastVerifiedAt: at, lastError: null };
  if (verified.seq === null || verified.coverage === null) return base;
  const seq = verified.seq;
  const next = withOldest({ ...base, captured: record.captured.filter((c) => c.seq > seq) });
  return { ...next, protectedThrough: min(verified.coverage, next.oldestUnprotectedEdit) };
}

/** A held-back push: records why, and leaves every deadline field as it was. */
export function withBlock(record: DeadlineRecord, block: BackupBlock): DeadlineRecord {
  return { ...record, lastBlock: block };
}

export function withError(record: DeadlineRecord, error: BackupErrorRecord): DeadlineRecord {
  return { ...record, lastError: error };
}

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const obj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/** Every finite edit time an older (or partly readable) record names; missing fields are skipped. */
function knownEditTimes(v: Record<string, unknown>): number[] {
  const times: number[] = [];
  const take = (x: unknown) => { if (isNum(x)) times.push(x); };
  take(v.oldestUnprotectedEdit);
  for (const key of ["pendingSince", "writing", "unlistedSince"]) if (obj(v[key])) Object.values(v[key]).forEach(take);
  if (obj(v.unflushed)) take(v.unflushed.from);
  for (const key of ["unflushed", "flushed", "captured"]) if (Array.isArray(v[key])) for (const item of v[key]) if (obj(item)) take(item.from);
  if (obj(v.writes)) for (const w of Object.values(v.writes)) if (obj(w)) take(w.since);
  return times;
}

/**
 * Replacement for a record this engine cannot use as it is: an older schema, an unknown one, or one that
 * is damaged (`value` undefined). Nothing it says is taken as evidence that an edit was saved or captured.
 * Its oldest known edit time is kept, never made later: the replacement holds one vault-wide unsaved edit
 * from the earliest time the old record names, or from `lastWritten` (the file's last write) when that is
 * earlier or nothing is named. Only an all-documents save acknowledgement, a complete capture after it and
 * that snapshot's verification clear it. Its pending files keep their floors.
 */
export function convertedRecord(value: unknown, lastWritten: number, now: number): DeadlineRecord {
  const v = obj(value) ? value : {};
  const floor = Math.min(lastWritten, now, ...knownEditTimes(v));
  const pendingSince: Record<string, number> = {};
  if (obj(v.pendingSince)) for (const [path, t] of Object.entries(v.pendingSince)) if (isNum(t)) pendingSince[path] = t;
  const schema = value === undefined ? "damaged" : isNum(v.schema) && Number.isSafeInteger(v.schema) ? v.schema : "damaged";
  const record: DeadlineRecord = {
    ...emptyRecord(),
    unflushed: [{ path: null, from: floor, first: 0, last: 0 }],
    pendingSince,
    snapshotSeq: Number.isSafeInteger(v.snapshotSeq) && (v.snapshotSeq as number) >= 0 ? (v.snapshotSeq as number) : 0,
    lastVerifiedSnapshot: typeof v.lastVerifiedSnapshot === "string" ? v.lastVerifiedSnapshot : null,
    lastVerifiedAt: isNum(v.lastVerifiedAt) ? v.lastVerifiedAt : null,
    protectedThrough: isNum(v.protectedThrough) ? Math.min(v.protectedThrough, floor) : null,
    recoveredFromDamagedRecord: true,
    convertedFrom: schema,
  };
  return withOldest(record);
}

export function protectionAgeSeconds(record: DeadlineRecord, now: number): number {
  if (record.oldestUnprotectedEdit === null) return 0;
  return Math.max(0, Math.floor((now - record.oldestUnprotectedEdit) / 1000));
}

/** Accepts a parsed JSON value only if it is a record of this schema; anything else is converted (see convertedRecord). */
export function parseRecord(value: unknown): DeadlineRecord | null {
  if (!obj(value)) return null;
  const v = value;
  if (v.schema !== 3) return null;
  const num = (x: unknown) => x === null || isNum(x);
  const str = (x: unknown) => x === null || typeof x === "string";
  const int = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
  const path = (x: unknown) => x === null || typeof x === "string";
  const times = (x: unknown) => obj(x) && Object.values(x).every(isNum);
  const cov = (x: unknown) => x === null || (obj(x) && typeof x.snapshot === "string" && typeof x.ref === "string" && num(x.seq) && num(x.coverage));
  const unflushed = (x: unknown) => Array.isArray(x) && x.every((u) => obj(u) && path(u.path) && isNum(u.from) && int(u.first) && int(u.last));
  const flushed = (x: unknown) => Array.isArray(x) && x.every((f) => obj(f) && path(f.path) && isNum(f.from) && int(f.ackGen));
  const captured = (x: unknown) => Array.isArray(x) && x.every((c) => obj(c) && isNum(c.seq) && isNum(c.from));
  const writes = (x: unknown) => obj(x) && Object.values(x).every((w) => obj(w) && int(w.gen) && typeof w.active === "boolean" && isNum(w.since));
  if (!int(v.generation) || !num(v.oldestUnprotectedEdit) || !num(v.latestEditNoted) || !str(v.lastVerifiedSnapshot) || !num(v.lastVerifiedAt) || !num(v.protectedThrough) || !isNum(v.snapshotSeq)) return null;
  if (!cov(v.lastCapture) || !cov(v.lastPushed) || !unflushed(v.unflushed) || !flushed(v.flushed) || !captured(v.captured) || !writes(v.writes)) return null;
  if (!times(v.pendingSince) || !times(v.unlistedSince)) return null;
  // Tickets and acknowledgements can never be ahead of the counter that handed them out.
  const gen = v.generation as number;
  if ((v.unflushed as UnflushedEdits[]).some((u) => u.last > gen) || (v.flushed as FlushedEdit[]).some((f) => f.ackGen > gen) || Object.values(v.writes as Record<string, WriteMark>).some((w) => w.gen > gen)) return null;
  return withOldest(value as unknown as DeadlineRecord);
}
