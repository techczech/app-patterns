/**
 * Reasons the engine refuses to work on a checkout, as plain states an app can show.
 *
 * - cloud-synced-location: the worktree's real path is in a cloud-synced folder or on a network mount.
 * - not-enabled: backup was never turned on for this checkout.
 * - enablement-stale: the folder moved or the remote changed since backup was turned on.
 * - unsupported-remote: the remote's set-up is outside what automatic backup supports (several
 *   addresses, different push and fetch addresses, an address that is not HTTPS or a local folder, or
 *   settings that choose programs Git would run); see destination.ts.
 * - public-remote-unconfirmed: the remote is public and publishing to it was not confirmed.
 * - visibility-unknown: the remote's visibility could not be established; snapshots continue locally.
 * - secret-found: the secret scan flagged blobs the push would add.
 * - scanner-unavailable: the secret scan could not run.
 * - too-large-to-scan: a text blob the push would add is above the scan size limit, or all of them
 *   together are above the total limit.
 * - unsupported-history: the checkout's backup branch holds commits this engine did not make (for
 *   example a chain from an older version with the repository's history as a parent); see chain.ts.
 *
 * A refusal never writes Git objects or refs and never moves the protection deadline.
 */
import type { NotScannedBlob, SecretFinding } from "./secret-scan.ts";

export type BlockReason =
  | "cloud-synced-location"
  | "not-enabled"
  | "enablement-stale"
  | "unsupported-remote"
  | "public-remote-unconfirmed"
  | "visibility-unknown"
  | "secret-found"
  | "scanner-unavailable"
  | "too-large-to-scan"
  | "unsupported-history";

export interface BackupBlock {
  reason: BlockReason;
  at: number;
  message: string;
  /** secret-found: paths and rule ids only. */
  findings?: SecretFinding[];
  /** too-large-to-scan (and informational on other pushes): blobs above the scan limit. */
  notScanned?: NotScannedBlob[];
}

export class BackupRefusedError extends Error {
  readonly reason: BlockReason;
  readonly block: BackupBlock;
  constructor(block: BackupBlock) {
    super(block.message);
    this.name = "BackupRefusedError";
    this.reason = block.reason;
    this.block = block;
  }
}
