/**
 * Snapshot commit messages identify the snapshot format and carry the engine's coverage record, so a
 * fresh checkout reading only the remote can tell what a snapshot holds without trusting its commit time:
 *
 *   snapshot-format: 2
 *   machine: <id>             checkout: <id>     (the chain this snapshot belongs to)
 *   coverage-through: <ms>    every edit made before this time was on disk and is in this snapshot,
 *                             except in the pending files and unlisted folders counted below
 *   pending-files: <n>        files the capture had to leave at an earlier version
 *   unlisted-folders: <n>     folders in scope the capture could not list; their contents are unknown
 *
 * The claim is the one the engine could make when it captured; later evidence never rewrites it. A
 * commit without all of these lines (another tool's commit, or an older engine) has unknown coverage.
 */
export const SNAPSHOT_FORMAT = 2;

export interface SnapshotMessage {
  startedAt: number;
  machineId: string;
  checkoutId: string;
  added: number;
  modified: number;
  removed: number;
  coverageThrough: number;
  pendingFiles: number;
  unlistedFolders: number;
}

export function formatSnapshotMessage(m: SnapshotMessage): string {
  return [
    `Automatic backup ${new Date(m.startedAt).toISOString()}`,
    "",
    `snapshot-format: ${SNAPSHOT_FORMAT}`,
    `machine: ${m.machineId}`,
    `checkout: ${m.checkoutId}`,
    `changed: ${m.added} added, ${m.modified} modified, ${m.removed} removed`,
    `coverage-through: ${Math.floor(m.coverageThrough)}`,
    `pending-files: ${m.pendingFiles}`,
    `unlisted-folders: ${m.unlistedFolders}`,
    "",
  ].join("\n");
}

export interface RecordedCoverage {
  coverageThrough: number;
  pendingFiles: number;
  unlistedFolders: number;
}

export interface ParsedSnapshotMessage extends RecordedCoverage {
  machineId: string;
  checkoutId: string;
}

const count = (message: string, key: string): number | null => {
  const m = new RegExp(`^${key}: (\\d{1,16})$`, "m").exec(message);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
};

/** The snapshot lines of a commit message in this format, or null when any is absent or malformed. */
export function parseSnapshotMessage(message: string): ParsedSnapshotMessage | null {
  if (!message.startsWith("Automatic backup ")) return null;
  if (count(message, "snapshot-format") !== SNAPSHOT_FORMAT) return null;
  const machine = /^machine: ([^\s]+)$/m.exec(message);
  const checkout = /^checkout: ([^\s]+)$/m.exec(message);
  const coverageThrough = count(message, "coverage-through");
  const pendingFiles = count(message, "pending-files");
  const unlistedFolders = count(message, "unlisted-folders");
  if (!machine || !checkout || coverageThrough === null || pendingFiles === null || unlistedFolders === null) return null;
  return { machineId: machine[1]!, checkoutId: checkout[1]!, coverageThrough, pendingFiles, unlistedFolders };
}

/** The coverage lines of a commit message, or null when it is not a snapshot of this format. */
export function parseCoverage(message: string): RecordedCoverage | null {
  const parsed = parseSnapshotMessage(message);
  return parsed ? { coverageThrough: parsed.coverageThrough, pendingFiles: parsed.pendingFiles, unlistedFolders: parsed.unlistedFolders } : null;
}
