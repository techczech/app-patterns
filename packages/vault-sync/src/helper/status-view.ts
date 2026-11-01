/**
 * The bounded form in which status and cycle reports travel over the socket.
 *
 * A vault can have any number of pending paths, unlisted folders, findings or skipped blobs, but a reply
 * line has a fixed limit. Each such list is sent as `{ count, items, omitted }`: the exact count, at most
 * `maxItems` of the entries in engine order, and how many were left out. Messages are cut to a fixed
 * length. Everything that decides what a vault's state means (summary, uncertainty, counts, timestamps,
 * enablement, block reasons) is carried in full and computed from the complete report before shortening,
 * so a shortened reply can never look cleaner than the full one.
 */
import type { BackupBlock } from "../blocks.ts";
import type { BackupStatus } from "../engine.ts";
import type { NotScannedBlob, SecretFinding } from "../secret-scan.ts";
import type { CycleReport, VaultStatusReport } from "./vault-worker.ts";

export interface ListView<T> {
  /** Exact number of entries. */
  count: number;
  /** The first entries, at most the reply's item limit. */
  items: T[];
  /** Entries left out of `items`; `count - items.length`. */
  omitted: number;
}

export type BlockView = Omit<BackupBlock, "findings" | "notScanned" | "message"> & {
  message: string;
  findings?: ListView<SecretFinding>;
  notScanned?: ListView<NotScannedBlob>;
};

export type EngineStatusView = Omit<BackupStatus, "pending" | "unlistedFolders" | "writing" | "repositoryHooksNotRun" | "block" | "lastError"> & {
  pending: ListView<string>;
  unlistedFolders: ListView<string>;
  writing: ListView<string>;
  repositoryHooksNotRun: ListView<string>;
  lastError: (Omit<NonNullable<BackupStatus["lastError"]>, "message"> & { message: string }) | null;
  block: BlockView | null;
};

export type CycleReportView = Omit<CycleReport, "capture" | "block"> & {
  capture: (Omit<NonNullable<CycleReport["capture"]>, "pending"> & { pending: ListView<string> }) | null;
  block: BlockView | null;
};

export type VaultStatusView = Omit<VaultStatusReport, "engine" | "helper"> & {
  helper: Omit<VaultStatusReport["helper"], "lastCycle"> & { lastCycle: CycleReportView | null };
  engine: EngineStatusView | null;
};

/** Longest message text in a reply. */
export const MAX_VIEW_MESSAGE = 500;
/** Item limits tried in turn until a reply fits; the last one sends counts only. */
export const VIEW_ITEM_LIMITS = [100, 10, 0] as const;

const text = (value: string) => (value.length > MAX_VIEW_MESSAGE ? `${value.slice(0, MAX_VIEW_MESSAGE)}…` : value);

export function listView<T>(entries: readonly T[], maxItems: number): ListView<T> {
  const items = entries.slice(0, Math.max(0, maxItems));
  return { count: entries.length, items, omitted: entries.length - items.length };
}

export function blockView(block: BackupBlock | null, maxItems: number): BlockView | null {
  if (!block) return null;
  const { findings, notScanned, message, ...rest } = block;
  return {
    ...rest,
    message: text(message),
    ...(findings ? { findings: listView(findings, maxItems) } : {}),
    ...(notScanned ? { notScanned: listView(notScanned, maxItems) } : {}),
  };
}

export function engineStatusView(status: BackupStatus | null, maxItems: number): EngineStatusView | null {
  if (!status) return null;
  return {
    ...status,
    pending: listView(status.pending, maxItems),
    unlistedFolders: listView(status.unlistedFolders, maxItems),
    writing: listView(status.writing, maxItems),
    repositoryHooksNotRun: listView(status.repositoryHooksNotRun, maxItems),
    lastError: status.lastError ? { ...status.lastError, message: text(status.lastError.message) } : null,
    block: blockView(status.block, maxItems),
  };
}

export function cycleReportView(report: CycleReport, maxItems: number): CycleReportView {
  return {
    ...report,
    capture: report.capture ? { ...report.capture, pending: listView(report.capture.pending, maxItems) } : null,
    push: report.push ? { ...report.push, ...(report.push.message !== undefined ? { message: text(report.push.message) } : {}) } : null,
    verify: report.verify ? { ...report.verify, ...(report.verify.message !== undefined ? { message: text(report.verify.message) } : {}) } : null,
    block: blockView(report.block, maxItems),
    error: report.error === null ? null : text(report.error),
  };
}

export function vaultStatusView(report: VaultStatusReport, maxItems: number): VaultStatusView {
  return {
    ...report,
    helper: { ...report.helper, lastCycle: report.helper.lastCycle ? cycleReportView(report.helper.lastCycle, maxItems) : null },
    engine: engineStatusView(report.engine, maxItems),
    statusError: report.statusError === null ? null : text(report.statusError),
  };
}
