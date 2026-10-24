/**
 * The deadline record: when the oldest edit that is not yet in a verified remote snapshot was first
 * observed. Only a verified snapshot moves it forward; capture, push failures and restarts never do.
 *
 * Times are milliseconds since the epoch. A snapshot "covers" every edit observed at or before the
 * moment its capture started, except files that capture had to leave pending.
 */

export interface SnapshotCoverage {
  snapshot: string;
  ref: string;
  /** Capture start time; edits observed at or before it are in the snapshot, unless pending. */
  coverage: number | null;
  /** Earliest time a file left pending in this snapshot was first seen unsettled; null if none. */
  pendingFloor: number | null;
}

export interface BackupErrorRecord {
  kind: "push-rejected" | "push-failed" | "verify-failed" | "verify-mismatch" | "capture-failed";
  at: number;
  message: string;
}

export interface DeadlineRecord {
  schema: 1;
  oldestUnprotectedEdit: number | null;
  latestEditNoted: number | null;
  lastVerifiedSnapshot: string | null;
  lastVerifiedAt: number | null;
  protectedThrough: number | null;
  lastCapture: SnapshotCoverage | null;
  lastPushed: SnapshotCoverage | null;
  /** Path -> first time capture found it unsettled, cleared once a capture reads it stably. */
  pendingSince: Record<string, number>;
  lastError: BackupErrorRecord | null;
  /** Set when an unreadable record was replaced; the age then counts from that file's last write. */
  recoveredFromDamagedRecord?: boolean;
}

export function emptyRecord(): DeadlineRecord {
  return {
    schema: 1,
    oldestUnprotectedEdit: null,
    latestEditNoted: null,
    lastVerifiedSnapshot: null,
    lastVerifiedAt: null,
    protectedThrough: null,
    lastCapture: null,
    lastPushed: null,
    pendingSince: {},
    lastError: null,
  };
}

const min = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.min(a, b));
const max = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));

export function noteEdit(record: DeadlineRecord, time: number): DeadlineRecord {
  if (!Number.isFinite(time)) throw new Error("edit time must be a finite number of milliseconds");
  return { ...record, oldestUnprotectedEdit: min(record.oldestUnprotectedEdit, time), latestEditNoted: max(record.latestEditNoted, time) };
}

export interface CaptureOutcome {
  snapshot: string;
  ref: string;
  startedAt: number;
  /** True if the capture saw any difference from the previous snapshot, or any pending file. */
  sawChange: boolean;
  readPaths: readonly string[];
  pendingPaths: readonly string[];
  /** Paths whose pending marks no longer apply (removed from disk or scope). */
  clearedPaths: readonly string[];
}

export function applyCapture(record: DeadlineRecord, outcome: CaptureOutcome): DeadlineRecord {
  let next = record;
  if (outcome.sawChange) next = noteEdit(next, outcome.startedAt);
  const pendingSince = { ...next.pendingSince };
  for (const path of outcome.readPaths) delete pendingSince[path];
  for (const path of outcome.clearedPaths) delete pendingSince[path];
  for (const path of outcome.pendingPaths) pendingSince[path] ??= outcome.startedAt;
  let pendingFloor: number | null = null;
  for (const path of outcome.pendingPaths) pendingFloor = min(pendingFloor, pendingSince[path] ?? outcome.startedAt);
  return {
    ...next,
    pendingSince,
    lastCapture: { snapshot: outcome.snapshot, ref: outcome.ref, coverage: outcome.startedAt, pendingFloor },
  };
}

export function applyPushed(record: DeadlineRecord, snapshot: string, ref: string): DeadlineRecord {
  const capture = record.lastCapture;
  const pushed: SnapshotCoverage = capture && capture.snapshot === snapshot
    ? { ...capture, ref }
    : { snapshot, ref, coverage: null, pendingFloor: null };
  return { ...record, lastPushed: pushed, lastError: null };
}

/** Applied only after ls-remote showed the remote ref at exactly the pushed object id. */
export function applyVerified(record: DeadlineRecord, verified: SnapshotCoverage, at: number): DeadlineRecord {
  const base = { ...record, lastVerifiedSnapshot: verified.snapshot, lastVerifiedAt: at, lastError: null };
  const c = verified.coverage;
  if (c === null) return base;
  let oldest = record.oldestUnprotectedEdit;
  if (oldest !== null && oldest <= c) {
    // Edits up to c are in the snapshot. Anything noted after c is still open; its exact time is not
    // kept, so c (earlier than any such edit) is the conservative start of the new window.
    oldest = record.latestEditNoted !== null && record.latestEditNoted > c ? c : null;
  }
  oldest = min(oldest, verified.pendingFloor);
  const through = verified.pendingFloor === null ? c : Math.min(c, verified.pendingFloor);
  return { ...base, oldestUnprotectedEdit: oldest, protectedThrough: through, recoveredFromDamagedRecord: oldest === null ? undefined : record.recoveredFromDamagedRecord };
}

export function withError(record: DeadlineRecord, error: BackupErrorRecord): DeadlineRecord {
  return { ...record, lastError: error };
}

export function protectionAgeSeconds(record: DeadlineRecord, now: number): number {
  if (record.oldestUnprotectedEdit === null) return 0;
  return Math.max(0, Math.floor((now - record.oldestUnprotectedEdit) / 1000));
}

/** Accepts a parsed JSON value only if it has the record's shape; anything else is treated as damaged. */
export function parseRecord(value: unknown): DeadlineRecord | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.schema !== 1) return null;
  const num = (x: unknown) => x === null || (typeof x === "number" && Number.isFinite(x));
  const str = (x: unknown) => x === null || typeof x === "string";
  const cov = (x: unknown) => {
    if (x === null) return true;
    if (!x || typeof x !== "object") return false;
    const c = x as Record<string, unknown>;
    return typeof c.snapshot === "string" && typeof c.ref === "string" && num(c.coverage) && num(c.pendingFloor);
  };
  if (!num(v.oldestUnprotectedEdit) || !num(v.latestEditNoted) || !str(v.lastVerifiedSnapshot) || !num(v.lastVerifiedAt) || !num(v.protectedThrough)) return null;
  if (!cov(v.lastCapture) || !cov(v.lastPushed)) return null;
  if (!v.pendingSince || typeof v.pendingSince !== "object" || Object.values(v.pendingSince).some((t) => typeof t !== "number")) return null;
  return value as DeadlineRecord;
}
