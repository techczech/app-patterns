/**
 * Backup engine: snapshot capture with a private index, per-checkout backup branches, normal push,
 * remote verification and the persistent protection deadline.
 *
 * Invariants:
 * - HEAD, the user's index, staged state and worktree files are never written. Capture uses only
 *   plumbing with GIT_INDEX_FILE pointing at the engine's own index, and updates only the backup ref.
 * - A snapshot's parents are only earlier snapshots. The user's commits are never parents, so a push
 *   publishes only content that was inside the backup scope when it was captured; publishing the user's
 *   history needs a separate consent and history check that this engine does not offer. A chain the
 *   engine did not make entirely (chain.ts) is neither extended nor pushed: "unsupported-history".
 * - Pushes are never forced; one checkout is the only writer of its chain, so a rejection is an error.
 * - Each push, verification and restore fetch validates the destination once at its start and then uses
 *   that literal address in the engine's own transport context (transport.ts), where no repository or
 *   user Git configuration applies. Only `ls-remote` at that address showing the pushed object id counts
 *   as verified, and only verification resolves an edit (deadline.ts).
 * - Guards run on every operation: a worktree in a cloud-synced folder or on a network mount is refused;
 *   capture, push and verify need an enablement record that still matches the folder and destination; a
 *   push also needs a private (or explicitly confirmed public) remote and a clean secret scan of every
 *   blob reachable from the snapshot it sends, the whole chain each time. A refusal writes no Git object or
 *   ref and leaves the deadline as it was.
 *
 * Writer contract. Stable reads reject a write that is visibly in progress but cannot prove a write is
 * complete. A writer is supported when it either replaces files atomically (temporary file, then rename),
 * or calls `noteWriteStart(paths)` before writing in place and `noteFlush` with its returned path/token
 * receipts once the bytes are durable;
 * the engine then keeps those paths at their previous snapshot version, including in any capture that was
 * reading while the write started or finished. An edit is reported with `noteEdit`, which returns its
 * ticket; a save is acknowledged with `noteFlush`, naming the saved paths (or all documents) and the newest
 * ticket the saved bytes contain. Edits are protected only through that acknowledgement, a capture that
 * started after it, and verification; reporting an edit never counts as saving it, and acknowledging one
 * document never counts for another. Edits the engine finds on disk without a report are protected from
 * the capture that read them.
 *
 * Editor receipts (`receipts`, engine-receipts.ts) are the tagged route: identified documents, sequenced
 * and deduplicated in the deadline record, under the record lock only. The untagged calls above never
 * touch receipt debt and never end a tagged write. Capture and publication refuse while the record is
 * quarantined or holds a receipt ledger from a newer engine (receipt-ledger.ts, recordSafety).
 */
import { devNull, homedir } from "node:os";
import { access, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { backupPrefix, validateId } from "./backup-ref.ts";
import { BackupRefusedError, type BackupBlock, type BlockReason } from "./blocks.ts";
import { captureWithRetry, latestSnapshot, type CaptureDeps, type CaptureResult, type RepoContext } from "./capture.ts";
import { chainProblem } from "./chain.ts";
import { checkDestination, type Destination } from "./destination.ts";
import { readEnablement, removeEnablement, urlDigest, writeEnablement, type EnablementRecord } from "./enablement.ts";
import { defaultMountInfo, isCloudSyncedLocation, isNetworkMount, type MountInfoReader } from "./location.ts";
import { collectPushBlobs, createGitleaksScanner, describeFindings, type NotScannedBlob, type SecretFinding, type SecretScanner, type SecretScanResult } from "./secret-scan.ts";
import { applyPushed, applyVerified, noteEdit as noteEditInRecord, noteFlush as noteFlushInRecord, noteWriteStart as noteWriteStartInRecord, protectionAgeSeconds, withBlock, withCaptureBlock, withError, type BackupErrorRecord, type DeadlineRecord, type EditTicket, type WriteToken, type FlushAcknowledgement, type SnapshotCoverage } from "./deadline.ts";
import { createReceiptsApi, type ReceiptsApi } from "./engine-receipts.ts";
import { checkoutId as readCheckoutId, engineFolder, ensureEngineFolder, loadRecord, saveRecord, withFolderLock } from "./engine-store.ts";
import { createGitRunner, type GitRunner, type ProcessLauncher } from "./git-process.ts";
import { createRestoreApi, type RestoreApi } from "./restore.ts";
import { ledgerUnflushedSince, recordSafety } from "./receipt-ledger.ts";
import { lsRemoteAt, pushIn, withTransport, type ObjectStore, type TransportContext } from "./transport.ts";
import type { BackupScope } from "./scope.ts";
import type { CaptureProjection } from "./projection.ts";

export type { CaptureResult, PendingFile, SkippedFile } from "./capture.ts";

export interface BackupEngineOptions {
  /** Stable id of this machine, used in backup branch names. */
  machineId: string;
  /** Configured remote name to push backup branches to. Default "origin". See destination.ts for supported set-ups. */
  remote?: string;
  /**
   * Credential helpers Git may run for an HTTPS destination, as `credential.helper` values (for example
   * "osxkeychain"). The app vouches for these; helpers configured in the repository or the user's Git
   * configuration never run. Default none.
   */
  trustedCredentialHelpers?: readonly string[];
  /** Clock for edit, capture and commit times (milliseconds). Default Date.now. */
  now?: () => number;
  /** A file whose last change is younger than this is re-read later. Default 250 ms. */
  settleMs?: number;
  /** Re-reads before a file is left pending. Default 3. */
  stableReadRetries?: number;
  /** Larger files are left pending with reason "too-large". Default 100 MiB. */
  maxFileBytes?: number;
  localTimeoutMs?: number;
  networkTimeoutMs?: number;
  maxOutputBytes?: number;
  /** How long an operation waits for another engine process working on the same checkout. */
  lockWaitMs?: number;
  author?: { name: string; email: string };
  gitPath?: string;
  /** Extra environment for every git call (after GIT_* variables are dropped). */
  gitEnv?: Record<string, string>;
  /** Home directory for the cloud-folder rules. Default os.homedir(). */
  homeDir?: string;
  /** Platform for the cloud-folder and mount rules. Default process.platform. */
  platform?: NodeJS.Platform;
  /** Environment read for OneDrive folders on Windows. Default process.env. */
  environment?: Record<string, string | undefined>;
  /** Mount lookup for the network-mount rule. Default reads the platform's mount table. */
  mountInfo?: MountInfoReader;
  /**
   * Visibility of a remote, given the address the engine will push to (which may carry credentials; do
   * not log it). Default answers "unknown", so pushes stay held back until an app supplies a real check.
   */
  remoteVisibility?: (remoteUrl: string) => Promise<RemoteVisibility>;
  /** A definite visibility answer is reused for this long. Default 10 minutes. */
  visibilityRecheckMs?: number;
  /** Secret scanner run before each push. Default runs gitleaks. */
  secretScanner?: SecretScanner;
  /**
   * Starts every Git process and the default scanner's process. Default `spawn`. It changes only how a
   * process is started and tracked, never what runs: the arguments, environment and limits are the engine's.
   */
  launch?: ProcessLauncher;
  /** Blobs above this size are not scanned. Default 10 MiB. */
  maxScanBlobBytes?: number;
  /** A push whose chain's blobs together exceed this is held back as too large to scan. Default 512 MiB. */
  maxScanTotalBytes?: number;
  /**
   * Optional trusted cohort every capture inserts as one unit (projection.ts). Absent: capture is
   * unchanged. A host passes one only from its own trusted code, never from configuration.
   */
  historyProjection?: CaptureProjection;
  /** One projection attempt's budget in milliseconds (default projection.ts PROJECTION_BUDGET_MS). */
  projectionBudgetMs?: number;
}

export type RemoteVisibility = "private" | "public" | "unknown";

export interface EnableOptions {
  /** Configured remote name. Default: the engine's remote. */
  remote?: string;
  /** Confirms that backup branches may be published to a public remote. */
  visibilityConfirmedPublic?: boolean;
  /**
   * The destination digest (enablement.ts urlDigest) of the address the user was shown. When given, enable
   * refuses unless the address it validates now, and would pin, has exactly this digest.
   */
  expectedDestinationDigest?: string;
}

export interface EnableResult {
  remote: string;
  realPath: string;
  visibility: RemoteVisibility;
}

export interface OperationOptions {
  signal?: AbortSignal;
}

export type PushResult =
  | { state: "pushed" | "up-to-date"; ref: string; snapshot: string; notScanned: NotScannedBlob[] }
  | { state: "blocked"; reason: BlockReason; message: string; findings?: SecretFinding[]; notScanned?: NotScannedBlob[] }
  | { state: "rejected" | "failed"; ref: string; snapshot: string; message: string }
  | { state: "no-snapshot"; message: string };

export type VerifyResult =
  | { verified: true; ref: string; snapshot: string }
  | { verified: false; state: "not-pushed" | "missing-on-remote" | "mismatch" | "failed"; ref?: string; expected?: string; remote?: string; message?: string }
  | { verified: false; state: "blocked"; reason: BlockReason; message: string };

export interface BackupStatus {
  machineId: string;
  checkoutId: string;
  protectionAgeSeconds: number;
  oldestUnprotectedEdit: number | null;
  lastVerifiedSnapshot: string | null;
  lastVerifiedAt: number | null;
  protectedThrough: number | null;
  latestSnapshot: string | null;
  latestRef: string | null;
  lastPushed: SnapshotCoverage | null;
  pending: string[];
  /** Folders in scope the last captures could not list ("" for the worktree root); their contents are unknown. */
  unlistedFolders: string[];
  /** Earliest edit reported with `noteEdit` that has no save acknowledgement yet; null when none. */
  unflushedEditSince: number | null;
  /** Paths a coordinated writer is writing in place (between `noteWriteStart` and `noteFlush`). */
  writing: string[];
  lastError: BackupErrorRecord | null;
  recoveredFromDamagedRecord: boolean;
  /** Hooks present in the repository that the engine does not run. */
  repositoryHooksNotRun: string[];
  /** True when an enablement record exists and still matches the folder and remote. */
  enabled: boolean;
  remote: string | null;
  /** Why backup is currently held back, or null. */
  block: BackupBlock | null;
}

export interface BackupEngine extends RestoreApi {
  /** Turns backup on for this checkout. Refuses cloud-synced folders and unconfirmed public remotes. */
  enable(repo: string, options?: EnableOptions): Promise<EnableResult>;
  /** Turns backup off for this checkout. */
  disable(repo: string): Promise<void>;
  /** Throws BackupRefusedError when a guard refuses. */
  capture(repo: string, scope: BackupScope, options?: OperationOptions): Promise<CaptureResult>;
  pushBackup(repo: string, options?: OperationOptions): Promise<PushResult>;
  verify(repo: string, options?: OperationOptions): Promise<VerifyResult>;
  /**
   * Reports an edit made at `time` (used only to measure its age) to the document at `path`, or, without
   * a path, an edit anywhere in the folder. Resolves with the edit's ticket. The edit stays unprotected
   * until a save acknowledgement covering its ticket and path, a later capture and its verification. An
   * edit reported without a path is covered only by an acknowledgement for all documents.
   */
  noteEdit(repo: string, time: number | Date, options?: { path?: string }): Promise<EditTicket>;
  /**
   * Reports a durable save: the named paths (or, with `allDocuments`, every document) are on disk and
   * contain every edit reported for them with ticket `upTo` or earlier. Ends only the coordinated intervals named by matching `completedWrites` path/token receipts.
   */
  noteFlush(repo: string, ack: FlushAcknowledgement): Promise<void>;
  /** Reports that a writer starts writing these worktree-relative paths in place; returns the interval token to supply in `noteFlush.completedWrites`. */
  noteWriteStart(repo: string, paths: readonly string[]): Promise<WriteToken>;
  status(repo: string, options?: OperationOptions): Promise<BackupStatus>;
  /** Editor receipts for a helper: record lock only, 2 000 ms budget, durable before every reply. */
  receipts: ReceiptsApi;
}

const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** A worktree-relative POSIX path as the scope reports it: no empty, "." or ".." parts, no NUL. */
function checkedPath(path: string): string {
  if (typeof path !== "string" || path === "" || path.includes("\0") || path.startsWith("/") || path.split("/").some((p) => p === "" || p === "." || p === "..")) {
    throw new Error("paths must be worktree-relative, like notes/a.md");
  }
  return path;
}

export function createBackupEngine(options: BackupEngineOptions): BackupEngine {
  const machineId = validateId("machine id", options.machineId);
  const remote = options.remote ?? "origin";
  if (!REMOTE_NAME.test(remote)) throw new Error("remote must be the name of a configured remote");
  const now = options.now ?? Date.now;
  const settleMs = options.settleMs ?? 250;
  const retries = options.stableReadRetries ?? 3;
  const maxFileBytes = options.maxFileBytes ?? 100 * 1024 * 1024;
  const localTimeoutMs = options.localTimeoutMs ?? 60_000;
  const networkTimeoutMs = options.networkTimeoutMs ?? 120_000;
  const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024 * 1024;
  const lockWaitMs = options.lockWaitMs ?? 120_000;
  const author = options.author ?? { name: "Automatic backup", email: "backup@vault-sync.invalid" };
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const mountInfo = options.mountInfo ?? defaultMountInfo(platform);
  const remoteVisibility = options.remoteVisibility ?? (async (): Promise<RemoteVisibility> => "unknown");
  const visibilityRecheckMs = options.visibilityRecheckMs ?? 10 * 60_000;
  const secretScanner = options.secretScanner ?? createGitleaksScanner({ launch: options.launch });
  const maxScanBlobBytes = options.maxScanBlobBytes ?? 10 * 1024 * 1024;
  const maxScanTotalBytes = options.maxScanTotalBytes ?? 512 * 1024 * 1024;
  const credentialHelpers = [...(options.trustedCredentialHelpers ?? [])];
  const runner = (hooksDir: string) => createGitRunner({ gitPath: options.gitPath, hooksDir, env: options.gitEnv, credentialHelpers, launch: options.launch });

  const contexts = new Map<string, Promise<RepoContext>>();
  const queues = new Map<string, Promise<unknown>>();
  /** Last definite visibility answer per checkout; "unknown" is never kept, so it is asked again. */
  const visibility = new Map<string, { digest: string; value: "private" | "public"; checkedAt: number }>();
  let homeDirs: Promise<string[]> | null = null;

  const local = (ctx: RepoContext, signal?: AbortSignal, env?: Record<string, string>) => ({ cwd: ctx.root, timeoutMs: localTimeoutMs, maxOutputBytes, signal, env });
  const localLimits = (signal?: AbortSignal) => ({ timeoutMs: localTimeoutMs, maxOutputBytes, signal });
  const networkLimits = (signal?: AbortSignal) => ({ timeoutMs: networkTimeoutMs, maxOutputBytes, signal });
  const objectStore = (commonDir: string, format: "sha1" | "sha256"): ObjectStore => ({ objectsDir: join(commonDir, "objects"), format });
  const storeOf = (ctx: RepoContext) => objectStore(ctx.commonDir, ctx.objectFormat);

  async function realRoot(repo: string): Promise<string> {
    if (typeof repo !== "string" || !isAbsolute(repo)) throw new Error("repo must be an absolute path to a worktree root");
    return realpath(resolve(repo));
  }

  /** Reads the repository layout without writing anything. */
  async function locate(real: string): Promise<{ gitDir: string; common: string; format: "sha1" | "sha256" }> {
    const probe = runner(devNull);
    const probeOptions = { cwd: real, timeoutMs: localTimeoutMs, maxOutputBytes: 64 * 1024 };
    const bare = (await probe.ok(["rev-parse", "--is-bare-repository"], probeOptions)).toString("utf8").trim();
    if (bare !== "false") throw new Error("bare repositories are not supported");
    const lines = (await probe.ok(["rev-parse", "--show-toplevel", "--absolute-git-dir", "--show-object-format", "--git-common-dir"], probeOptions)).toString("utf8").split("\n");
    const [top, gitDir, format, common] = lines;
    if (!top || !gitDir || !common || (format !== "sha1" && format !== "sha256")) throw new Error("could not read repository layout");
    if ((await realpath(top)) !== real) throw new Error("repo must be the worktree root, not a folder inside it");
    return { gitDir, common, format };
  }

  async function openRepo(real: string): Promise<RepoContext> {
    const { gitDir, common, format } = await locate(real);
    const folder = engineFolder(gitDir);
    await ensureEngineFolder(folder);
    const checkoutId = await readCheckoutId(folder);
    return {
      root: real,
      commonDir: isAbsolute(common) ? common : resolve(real, common),
      folder,
      checkoutId,
      prefix: backupPrefix(machineId, checkoutId),
      objectFormat: format,
      zeroOid: "0".repeat(format === "sha1" ? 40 : 64),
      git: runner(folder.hooksDir),
      cache: new Map(),
    };
  }

  /** Keyed by the real path, resolved on every call, so a moved or relinked folder gets a fresh context. */
  function context(real: string): Promise<RepoContext> {
    let ctx = contexts.get(real);
    if (!ctx) {
      ctx = openRepo(real);
      contexts.set(real, ctx);
      ctx.catch(() => contexts.delete(real));
    }
    return ctx;
  }

  const block = (reason: BlockReason, message: string, extra: Partial<BackupBlock> = {}): BackupBlock => ({ ...extra, reason, at: now(), message });

  function homes(): Promise<string[]> {
    homeDirs ??= (async () => {
      const home = options.homeDir ?? homedir();
      try {
        const real = await realpath(home);
        return real === home ? [home] : [home, real];
      } catch {
        return [home];
      }
    })();
    return homeDirs;
  }

  /** Cloud-folder and network-mount rules, checked against the current real path on every operation. */
  async function locationBlock(real: string): Promise<BackupBlock | null> {
    for (const home of await homes()) {
      const found = isCloudSyncedLocation(real, { homeDir: home, platform, env: environment });
      if (found.cloud) return block("cloud-synced-location", "this folder is inside a cloud-synced folder (such as OneDrive, iCloud Drive, Dropbox or Google Drive); automatic backup does not run there");
    }
    let mount = null;
    try {
      mount = await mountInfo(real);
    } catch {
      // Fail closed: if the drive type cannot be read, the folder may be on a network share.
      return block("cloud-synced-location", "could not check what kind of drive this folder is on; automatic backup does not run until it can");
    }
    if (mount && isNetworkMount(mount)) return block("cloud-synced-location", "this folder is on a network drive; automatic backup does not run there");
    return null;
  }

  const notEnabled = () => block("not-enabled", "automatic backup has not been turned on for this folder");

  /** Refusals that need no engine folder: a cloud location, or a checkout never enabled. */
  async function admit(repo: string): Promise<{ ctx: RepoContext } | { block: BackupBlock }> {
    const real = await realRoot(repo);
    const where = await locationBlock(real);
    if (where) return { block: where };
    if (!contexts.has(real)) {
      const { gitDir } = await locate(real);
      try {
        await access(engineFolder(gitDir).enablementFile);
      } catch {
        return { block: notEnabled() };
      }
    }
    return { ctx: await context(real) };
  }

  /** The validated destination for a remote name, or why it cannot be used. */
  async function destinationOf(git: GitRunner, root: string, name: string, signal?: AbortSignal): Promise<{ destination: Destination } | { block: BackupBlock }> {
    const checked = await checkDestination(git, { cwd: root, timeoutMs: localTimeoutMs, maxOutputBytes, signal }, name, platform);
    if ("missing" in checked) return { block: block("enablement-stale", `the backup remote ${name} is not configured in this repository`) };
    if ("unsupported" in checked) return { block: block("unsupported-remote", checked.unsupported) };
    return checked;
  }

  interface Enabled {
    record: EnablementRecord;
    destination: Destination;
  }

  /** The enablement record must exist and still match the folder's real path and the validated destination's address. */
  async function enablementState(ctx: RepoContext, signal?: AbortSignal): Promise<{ enabled: Enabled } | { block: BackupBlock }> {
    const record = await readEnablement(ctx.folder.enablementFile);
    if (!record) return { block: notEnabled() };
    if (record.realPath !== ctx.root) return { block: block("enablement-stale", "this folder was moved or renamed after automatic backup was turned on; turn it on again here") };
    const found = await destinationOf(ctx.git, ctx.root, record.remote, signal);
    if ("block" in found) return found;
    const digest = urlDigest(found.destination.url);
    if (digest !== record.fetchUrlDigest || digest !== record.pushUrlDigest) {
      return { block: block("enablement-stale", "the backup remote's address changed after automatic backup was turned on; turn it on again") };
    }
    return { enabled: { record, destination: found.destination } };
  }

  async function checkVisibility(ctx: RepoContext, digest: string, pushUrl: string, force: boolean): Promise<RemoteVisibility> {
    const key = ctx.folder.dir;
    const cached = visibility.get(key);
    const t = now();
    if (!force && cached && cached.digest === digest && t >= cached.checkedAt && t - cached.checkedAt < visibilityRecheckMs) return cached.value;
    let value: RemoteVisibility;
    try {
      const answer = await remoteVisibility(pushUrl);
      value = answer === "private" || answer === "public" ? answer : "unknown";
    } catch {
      value = "unknown";
    }
    if (value === "unknown") visibility.delete(key);
    else visibility.set(key, { digest, value, checkedAt: t });
    return value;
  }

  function visibilityBlock(value: RemoteVisibility, confirmedPublic: boolean): BackupBlock | null {
    if (value === "public" && !confirmedPublic) return block("public-remote-unconfirmed", "the backup remote is public; confirm that drafts may be published there before backup continues");
    if (value === "unknown") return block("visibility-unknown", "could not check whether the backup remote is private; snapshots are kept on this computer until it can be checked");
    return null;
  }

  /**
   * Scans every blob reachable from the snapshot about to be pushed, in the push's own transport context:
   * the whole chain, each time, because nothing proves the destination still holds any of it when the
   * push runs. Any doubt holds the push back.
   */
  async function scanForPush(t: TransportContext, tip: string, signal?: AbortSignal): Promise<{ notScanned: NotScannedBlob[] } | { block: BackupBlock }> {
    let collected;
    try {
      collected = await collectPushBlobs({ git: runner(devNull), run: t.options(localLimits(signal)), newTip: tip, maxBlobBytes: maxScanBlobBytes, maxTotalBytes: maxScanTotalBytes });
    } catch {
      signal?.throwIfAborted();
      return { block: block("scanner-unavailable", "could not list the files this backup would send, so they were not scanned") };
    }
    if (collected.overTotal) return { block: block("too-large-to-scan", "the files this backup would send are larger in total than the secret-scan limit") };
    const largeText = collected.notScanned.filter((b) => !b.binary);
    if (largeText.length > 0) {
      const names = largeText.slice(0, 20).map((b) => b.path).join(", ");
      return { block: block("too-large-to-scan", `${largeText.length} text file${largeText.length === 1 ? " is" : "s are"} larger than the secret-scan limit: ${names}`, { notScanned: largeText }) };
    }
    let result: SecretScanResult;
    try {
      result = await secretScanner(collected.blobs);
    } catch {
      result = { unavailable: "the secret scanner failed" };
    }
    if ("unavailable" in result) return { block: block("scanner-unavailable", `secret scan could not run: ${String(result.unavailable).slice(0, 200)}`) };
    if (result.findings.length > 0) {
      const findings = result.findings.map((f) => ({ path: String(f.path), rule: String(f.rule) }));
      return { block: block("secret-found", describeFindings(findings), { findings }) };
    }
    return { notScanned: collected.notScanned };
  }

  function blockedPush(b: BackupBlock): PushResult {
    const result: PushResult = { state: "blocked", reason: b.reason, message: b.message };
    if (b.findings) result.findings = b.findings;
    if (b.notScanned) result.notScanned = b.notScanned;
    return result;
  }

  /** Records why a push was held back; the deadline fields are untouched. */
  async function holdPush(ctx: RepoContext, b: BackupBlock): Promise<PushResult> {
    await persist(ctx, (r) => withBlock(r, b));
    return blockedPush(b);
  }

  /** Serialises operations per checkout inside this process; the folder lock covers other processes. */
  async function exclusive<T>(ctx: RepoContext, fn: () => Promise<T>): Promise<T> {
    const key = ctx.folder.dir;
    const previous = queues.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => withFolderLock(ctx.folder.lockDir, { waitMs: lockWaitMs }, fn));
    queues.set(key, run.catch(() => undefined));
    return run;
  }

  /**
   * Read-change-write of the deadline record under its own short lock. Edit and save reports take only
   * this lock, so they never wait behind a capture, push or verify holding the operation lock.
   */
  function persist(ctx: RepoContext, change: (record: DeadlineRecord) => DeadlineRecord): Promise<DeadlineRecord> {
    return withFolderLock(ctx.folder.recordLockDir, { waitMs: lockWaitMs }, async () => {
      const next = change(await loadRecord(ctx.folder));
      await saveRecord(ctx.folder, next);
      return next;
    });
  }

  /** The current record (a damaged one is set aside and replaced under the record lock). */
  function readRecord(ctx: RepoContext): Promise<DeadlineRecord> {
    return withFolderLock(ctx.folder.recordLockDir, { waitMs: lockWaitMs }, () => loadRecord(ctx.folder));
  }

  async function recordError(ctx: RepoContext, kind: BackupErrorRecord["kind"], message: string): Promise<void> {
    await persist(ctx, (record) => withError(record, { kind, at: now(), message: message.slice(0, 2000) }));
  }

  // A projected cohort shares the push scan's total limit: everything it emits is scanned before a push.
  const captureDeps: CaptureDeps = { machineId, now, settleMs, retries, maxFileBytes, author, run: local, readRecord, persist, ...(options.historyProjection ? { projection: options.historyProjection, maxProjectedTotalBytes: maxScanTotalBytes, ...(options.projectionBudgetMs ? { projectionBudgetMs: options.projectionBudgetMs } : {}) } : {}) };
  const latest = (ctx: RepoContext, signal?: AbortSignal) => latestSnapshot(ctx, local(ctx, signal));

  async function hooksNotRun(ctx: RepoContext): Promise<string[]> {
    const probe = runner(ctx.folder.hooksDir);
    // Ask with the repository's own configuration: run `config` rather than `rev-parse --git-path`,
    // because the engine's override would otherwise report its own empty folder.
    const configured = await probe.run(["config", "--get-all", "--includes", "--show-origin", "core.hooksPath"], local(ctx));
    let dir = join(ctx.commonDir, "hooks");
    const lines = configured.stdout.toString("utf8").split("\n").filter((line) => line && !line.startsWith("command line:"));
    const value = lines[lines.length - 1]?.split("\t")[1];
    if (value) dir = isAbsolute(value) ? value : join(ctx.root, value);
    try {
      const names = await readdir(dir);
      const found: string[] = [];
      for (const name of names) {
        if (name.endsWith(".sample")) continue;
        try {
          const s = await stat(join(dir, name));
          if (s.isFile() && (s.mode & 0o111) !== 0) found.push(name);
        } catch { /* ignore */ }
      }
      return found.sort();
    } catch {
      return [];
    }
  }

  const restoreApi = createRestoreApi({
    now,
    authorEmail: author.email,
    maxFileBytes,
    localTimeoutMs,
    networkTimeoutMs,
    maxOutputBytes,
    // Restore needs a worktree root but not an enablement record, and it writes no engine state.
    realRoot: async (repo) => {
      const real = await realRoot(repo);
      await locate(real);
      return real;
    },
    locationBlock,
    runner: () => runner(devNull),
    // The remote asked for; else the one this checkout was enabled with; else the engine's default. A
    // fresh checkout with no enablement record passes `remote` to read another remote's backups.
    destination: async (real, requested, signal) => {
      let name = requested;
      if (name === undefined) {
        const { gitDir } = await locate(real);
        const record = await readEnablement(engineFolder(gitDir).enablementFile);
        name = record && record.realPath === real ? record.remote : remote;
      }
      if (!REMOTE_NAME.test(name)) throw new Error("remote must be the name of a configured remote");
      const found = await destinationOf(runner(devNull), real, name, signal);
      if ("block" in found) throw new BackupRefusedError(found.block);
      const { common, format } = await locate(real);
      return { ...found.destination, store: objectStore(isAbsolute(common) ? common : resolve(real, common), format) };
    },
  });

  const receipts = createReceiptsApi({
    now,
    locate: async (repo) => {
      const ctx = await context(await realRoot(repo));
      return { folder: ctx.folder, objectFormat: ctx.objectFormat };
    },
  });

  return {
    ...restoreApi,
    receipts,
    async enable(repo, opts = {}) {
      const real = await realRoot(repo);
      const where = await locationBlock(real);
      if (where) throw new BackupRefusedError(where);
      const name = opts.remote ?? remote;
      if (!REMOTE_NAME.test(name)) throw new Error("remote must be the name of a configured remote");
      const confirmed = opts.visibilityConfirmedPublic === true;
      const expected = opts.expectedDestinationDigest;
      if (expected !== undefined && (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected))) throw new Error("expectedDestinationDigest must be a SHA-256 digest in lower-case hex");
      const ctx = await context(real);
      return exclusive(ctx, async (): Promise<EnableResult> => {
        const found = await destinationOf(ctx.git, ctx.root, name);
        if ("block" in found) {
          if (found.block.reason === "unsupported-remote") throw new BackupRefusedError(found.block);
          throw new Error(`remote ${name} is not configured in this repository`);
        }
        const digest = urlDigest(found.destination.url);
        // The address pinned below is this one; it must be the one the user was shown.
        if (expected !== undefined && digest !== expected) throw new BackupRefusedError(block("enablement-stale", "the backup remote's address is not the one shown when backup was turned on; check it again"));
        const seen = await checkVisibility(ctx, digest, found.destination.url, true);
        if (seen === "public" && !confirmed) throw new BackupRefusedError(visibilityBlock(seen, false)!);
        await writeEnablement(ctx.folder.enablementFile, {
          schema: 1,
          realPath: ctx.root,
          remote: name,
          fetchUrlDigest: digest,
          pushUrlDigest: digest,
          visibilityConfirmedPublic: confirmed,
          enabledAt: now(),
        });
        await persist(ctx, (r) => ({ ...r, lastBlock: null }));
        return { remote: name, realPath: ctx.root, visibility: seen };
      });
    },

    async disable(repo) {
      const ctx = await context(await realRoot(repo));
      await exclusive(ctx, async () => {
        await removeEnablement(ctx.folder.enablementFile);
        visibility.delete(ctx.folder.dir);
      });
    },

    async capture(repo, scope, opts = {}) {
      const admitted = await admit(repo);
      if ("block" in admitted) throw new BackupRefusedError(admitted.block);
      const { ctx } = admitted;
      return exclusive(ctx, async () => {
        const state = await enablementState(ctx, opts.signal);
        if ("block" in state) throw new BackupRefusedError(state.block);
        try {
          return await captureWithRetry(ctx, scope, captureDeps, opts.signal);
        } catch (error) {
          // The projection's condition is the capture's own health, kept apart from push blocks (S2).
          if (error instanceof BackupRefusedError) await persist(ctx, (r) => (error.block.reason === "history-unavailable" ? withCaptureBlock(r, error.block) : withBlock(r, error.block))).catch(() => undefined);
          else await recordError(ctx, "capture-failed", (error as Error).message).catch(() => undefined);
          throw error;
        }
      });
    },

    async pushBackup(repo, opts = {}) {
      const admitted = await admit(repo);
      if ("block" in admitted) return blockedPush(admitted.block);
      const { ctx } = admitted;
      return exclusive(ctx, async (): Promise<PushResult> => {
        const state = await enablementState(ctx, opts.signal);
        if ("block" in state) return blockedPush(state.block);
        const { record: enabled, destination } = state.enabled;
        const seen = await checkVisibility(ctx, enabled.pushUrlDigest, destination.url, false);
        const hidden = visibilityBlock(seen, enabled.visibilityConfirmedPublic);
        if (hidden) return holdPush(ctx, hidden);
        const current = await latest(ctx, opts.signal);
        if (!current) return { state: "no-snapshot", message: "no backup snapshot has been captured yet" };
        const who = { email: author.email, machineId, checkoutId: ctx.checkoutId };
        // History check, scan and push share one transport context, so all three see the same objects and
        // the push goes to the address validated above, whatever the repository's configuration says now.
        let outcome: { block: BackupBlock } | { failed: string } | { unsafe: string } | { result: Awaited<ReturnType<typeof pushIn>>; notScanned: NotScannedBlob[] };
        try {
          outcome = await withTransport(storeOf(ctx), async (t) => {
            const problem = await chainProblem(runner(devNull), t.options(localLimits(opts.signal)), ctx.folder, current.oid, who);
            if (problem) return { block: block("unsupported-history", `${problem}; automatic backup does not extend or publish it`) };
            const scanned = await scanForPush(t, current.oid, opts.signal);
            if ("block" in scanned) return scanned;
            // The record's safety, checked again immediately before any object is sent.
            const safety = recordSafety(await readRecord(ctx));
            if ("unsafe" in safety) return { unsafe: safety.unsafe };
            return { result: await pushIn(ctx.git, t, destination.url, current.oid, current.ref, networkLimits(opts.signal)), notScanned: scanned.notScanned };
          });
        } catch (error) {
          outcome = { failed: (error as Error).message };
        }
        if ("block" in outcome) return holdPush(ctx, outcome.block);
        if ("unsafe" in outcome) {
          await recordError(ctx, "push-failed", outcome.unsafe).catch(() => undefined);
          return { state: "failed", ref: current.ref, snapshot: current.oid, message: outcome.unsafe };
        }
        if ("failed" in outcome) {
          await recordError(ctx, "push-failed", outcome.failed);
          return { state: "failed", ref: current.ref, snapshot: current.oid, message: outcome.failed };
        }
        const { result, notScanned } = outcome;
        const line = result.stdout.toString("utf8").split("\n").find((l) => l.includes(`\t${current.ref}:${current.ref}\t`));
        const flag = line?.[0];
        if (flag === "!") {
          const message = `remote refused the backup branch update (${line?.split("\t")[2] ?? "rejected"})`;
          await recordError(ctx, "push-rejected", message);
          return { state: "rejected", ref: current.ref, snapshot: current.oid, message };
        }
        if (result.code !== 0 || (flag !== " " && flag !== "*" && flag !== "=" && flag !== "+")) {
          const message = result.stderr.trim().split("\n").slice(-3).join(" ") || `push exited with ${result.code}`;
          await recordError(ctx, "push-failed", message);
          return { state: "failed", ref: current.ref, snapshot: current.oid, message };
        }
        await persist(ctx, (r) => applyPushed(r, current.oid, current.ref));
        return { state: flag === "=" ? "up-to-date" : "pushed", ref: current.ref, snapshot: current.oid, notScanned };
      });
    },

    async verify(repo, opts = {}) {
      const admitted = await admit(repo);
      if ("block" in admitted) return { verified: false, state: "blocked", reason: admitted.block.reason, message: admitted.block.message };
      const { ctx } = admitted;
      return exclusive(ctx, async (): Promise<VerifyResult> => {
        const state = await enablementState(ctx, opts.signal);
        if ("block" in state) return { verified: false, state: "blocked", reason: state.block.reason, message: state.block.message };
        const { destination } = state.enabled;
        const record = await readRecord(ctx);
        const pushed = record.lastPushed;
        if (!pushed) return { verified: false, state: "not-pushed" };
        let out;
        try {
          out = await lsRemoteAt(ctx.git, storeOf(ctx), destination.url, [pushed.ref], networkLimits(opts.signal));
        } catch (error) {
          const message = (error as Error).message;
          await recordError(ctx, "verify-failed", message);
          return { verified: false, state: "failed", ref: pushed.ref, expected: pushed.snapshot, message };
        }
        const remoteOid = out.toString("utf8").split("\n").map((l) => l.split("\t")).find(([, name]) => name === pushed.ref)?.[0];
        if (!remoteOid) {
          await recordError(ctx, "verify-mismatch", "the backup branch is not on the remote");
          return { verified: false, state: "missing-on-remote", ref: pushed.ref, expected: pushed.snapshot };
        }
        if (remoteOid !== pushed.snapshot) {
          await recordError(ctx, "verify-mismatch", "the remote backup branch points at a different snapshot");
          return { verified: false, state: "mismatch", ref: pushed.ref, expected: pushed.snapshot, remote: remoteOid };
        }
        await persist(ctx, (r) => applyVerified(r, pushed, now()));
        return { verified: true, ref: pushed.ref, snapshot: pushed.snapshot };
      });
    },

    async noteEdit(repo, time, opts = {}) {
      const ms = time instanceof Date ? time.getTime() : time;
      if (!Number.isFinite(ms)) throw new Error("edit time must be a Date or finite milliseconds");
      const path = opts.path === undefined ? null : checkedPath(opts.path);
      const ctx = await context(await realRoot(repo));
      let ticket = 0;
      await persist(ctx, (r) => {
        const next = noteEditInRecord(r, ms, path);
        ticket = next.ticket;
        return next.record;
      });
      return ticket;
    },

    async noteFlush(repo, ack) {
      if (!ack || typeof ack !== "object" || "through" in ack) throw new Error("a save acknowledgement is { upTo: <ticket from noteEdit>, paths } or { upTo, allDocuments: true }");
      if (ack.completedWrites !== undefined && !Array.isArray(ack.completedWrites)) throw new Error("completedWrites must be an array of path/token receipts");
      const completedWrites = ack.completedWrites?.map((receipt) => ({ path: checkedPath(receipt?.path), token: receipt?.token }));
      const checked: FlushAcknowledgement = ack.allDocuments === true
        ? { upTo: ack.upTo, allDocuments: true, completedWrites }
        : { upTo: ack.upTo, paths: (Array.isArray(ack.paths) ? ack.paths : []).map(checkedPath), completedWrites };
      const ctx = await context(await realRoot(repo));
      await persist(ctx, (r) => noteFlushInRecord(r, checked, now()));
    },

    async noteWriteStart(repo, paths) {
      const checked = paths.map(checkedPath);
      const ctx = await context(await realRoot(repo));
      const record = await persist(ctx, (r) => noteWriteStartInRecord(r, checked, now()));
      return record.generation;
    },

    async status(repo, opts = {}) {
      const real = await realRoot(repo);
      const where = await locationBlock(real);
      const ctx = await context(real);
      return exclusive(ctx, async (): Promise<BackupStatus> => {
        const record = await readRecord(ctx);
        const current = await latest(ctx, opts.signal);
        const state = await enablementState(ctx, opts.signal);
        // Live guards first, then the cached visibility answer (no network here), then the last held-back push.
        let held: BackupBlock | null = where ?? ("block" in state ? state.block : null);
        if (!held && "enabled" in state) {
          const cached = visibility.get(ctx.folder.dir);
          if (cached && cached.digest === state.enabled.record.pushUrlDigest) held = visibilityBlock(cached.value, state.enabled.record.visibilityConfirmedPublic);
        }
        // A capture held back by its projection stays shown until a complete cohort is captured.
        held ??= record.captureBlock ?? record.lastBlock ?? null;
        return {
          machineId,
          checkoutId: ctx.checkoutId,
          protectionAgeSeconds: protectionAgeSeconds(record, now()),
          oldestUnprotectedEdit: record.oldestUnprotectedEdit,
          lastVerifiedSnapshot: record.lastVerifiedSnapshot,
          lastVerifiedAt: record.lastVerifiedAt,
          protectedThrough: record.protectedThrough,
          latestSnapshot: current?.oid ?? null,
          latestRef: current?.ref ?? null,
          lastPushed: record.lastPushed,
          pending: Object.keys(record.pendingSince).sort(),
          unlistedFolders: Object.keys(record.unlistedSince).sort(),
          unflushedEditSince: record.unflushed.reduce<number | null>((oldest, u) => (oldest === null ? u.from : Math.min(oldest, u.from)), ledgerUnflushedSince(record.receipts)),
          writing: Object.entries(record.writes).filter(([, w]) => w.active).map(([path]) => path).sort(),
          lastError: record.lastError,
          recoveredFromDamagedRecord: record.recoveredFromDamagedRecord === true,
          repositoryHooksNotRun: await hooksNotRun(ctx),
          enabled: "enabled" in state,
          remote: "enabled" in state ? state.enabled.record.remote : null,
          block: held,
        };
      });
    },
  };
}
