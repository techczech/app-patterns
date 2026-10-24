/**
 * Backup engine: snapshot capture with a private index, per-checkout backup branches, normal push,
 * remote verification and the persistent protection deadline.
 *
 * Invariants:
 * - HEAD, the user's index, staged state and worktree files are never written. Capture uses only
 *   plumbing with GIT_INDEX_FILE pointing at the engine's own index, and updates only the backup ref.
 * - Pushes are never forced; one checkout is the only writer of its chain, so a rejection is an error.
 * - Only `ls-remote` showing the pushed object id counts as verified, and only verification moves the
 *   oldest unprotected edit forward.
 * - Guards run on every operation: a worktree in a cloud-synced folder or on a network mount is refused;
 *   capture, push and verify need an enablement record that still matches the folder and remote; a push
 *   also needs a private (or explicitly confirmed public) remote and a clean secret scan. A refusal
 *   writes no Git object or ref and leaves the deadline as it was.
 */
import { createHash } from "node:crypto";
import { devNull, homedir } from "node:os";
import { access, lstat, readdir, realpath, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { backupPrefix, backupRef, latestDayRef, validateId } from "./backup-ref.ts";
import { BackupRefusedError, type BackupBlock, type BlockReason } from "./blocks.ts";
import { readEnablement, removeEnablement, urlDigest, writeEnablement, type EnablementRecord } from "./enablement.ts";
import { defaultMountInfo, isCloudSyncedLocation, isNetworkMount, type MountInfoReader } from "./location.ts";
import { collectPushBlobs, createGitleaksScanner, describeFindings, type NotScannedBlob, type SecretFinding, type SecretScanner, type SecretScanResult } from "./secret-scan.ts";
import { applyCapture, applyPushed, applyVerified, noteEdit as noteEditInRecord, protectionAgeSeconds, withBlock, withError, type BackupErrorRecord, type DeadlineRecord, type SnapshotCoverage } from "./deadline.ts";
import { checkoutId as readCheckoutId, engineFolder, ensureEngineFolder, loadRecord, saveRecord, withFolderLock, type EngineFolder } from "./engine-store.ts";
import { createGitRunner, GitProcessError, splitNul, type GitRunner } from "./git-process.ts";
import { compileScope, listScope, type BackupScope, type SkippedPath } from "./scope.ts";
import { checkContainment, readStable, statKey, type GitFileMode } from "./stable-read.ts";

export interface BackupEngineOptions {
  /** Stable id of this machine, used in backup branch names. */
  machineId: string;
  /** Configured remote name to push backup branches to. Default "origin". */
  remote?: string;
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
   * Visibility of a remote, given its push URL (which may carry credentials; do not log it). Default
   * answers "unknown", so pushes stay held back until an app supplies a real check.
   */
  remoteVisibility?: (remoteUrl: string) => Promise<RemoteVisibility>;
  /** A definite visibility answer is reused for this long. Default 10 minutes. */
  visibilityRecheckMs?: number;
  /** Secret scanner run before each push. Default runs gitleaks. */
  secretScanner?: SecretScanner;
  /** Blobs above this size are not scanned. Default 10 MiB. */
  maxScanBlobBytes?: number;
  /** A push whose new blobs together exceed this is held back as too large to scan. Default 512 MiB. */
  maxScanTotalBytes?: number;
}

export type RemoteVisibility = "private" | "public" | "unknown";

export interface EnableOptions {
  /** Configured remote name. Default: the engine's remote. */
  remote?: string;
  /** Confirms that backup branches may be published to a public remote. */
  visibilityConfirmedPublic?: boolean;
}

export interface EnableResult {
  remote: string;
  realPath: string;
  visibility: RemoteVisibility;
}

export interface OperationOptions {
  signal?: AbortSignal;
}

export interface PendingFile {
  path: string;
  reason: "unstable" | "too-large" | "unreadable";
}

/**
 * A scoped path (or include base) that lies beyond a symlinked directory. It is never read; if it was in
 * the previous snapshot it is removed from the next one rather than kept with bytes from outside.
 */
export type SkippedFile = SkippedPath;

export interface CaptureResult {
  committed: boolean;
  snapshot: string | null;
  ref: string | null;
  startedAt: number;
  added: string[];
  modified: string[];
  removed: string[];
  pending: PendingFile[];
  /** Paths not captured because they lie beyond a symlinked directory. */
  skipped: SkippedFile[];
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

export interface BackupEngine {
  /** Turns backup on for this checkout. Refuses cloud-synced folders and unconfirmed public remotes. */
  enable(repo: string, options?: EnableOptions): Promise<EnableResult>;
  /** Turns backup off for this checkout. */
  disable(repo: string): Promise<void>;
  /** Throws BackupRefusedError when a guard refuses. */
  capture(repo: string, scope: BackupScope, options?: OperationOptions): Promise<CaptureResult>;
  pushBackup(repo: string, options?: OperationOptions): Promise<PushResult>;
  verify(repo: string, options?: OperationOptions): Promise<VerifyResult>;
  noteEdit(repo: string, time: number | Date): Promise<void>;
  status(repo: string, options?: OperationOptions): Promise<BackupStatus>;
}

interface RepoContext {
  root: string;
  commonDir: string;
  folder: EngineFolder;
  checkoutId: string;
  prefix: string;
  objectFormat: "sha1" | "sha256";
  zeroOid: string;
  git: GitRunner;
  cache: Map<string, { key: string; oid: string; mode: GitFileMode }>;
}

interface TreeEntry {
  mode: string;
  oid: string;
}

const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const CACHE_MIN_AGE_MS = 2000;

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
  const secretScanner = options.secretScanner ?? createGitleaksScanner();
  const maxScanBlobBytes = options.maxScanBlobBytes ?? 10 * 1024 * 1024;
  const maxScanTotalBytes = options.maxScanTotalBytes ?? 512 * 1024 * 1024;

  const contexts = new Map<string, Promise<RepoContext>>();
  const queues = new Map<string, Promise<unknown>>();
  /** Last definite visibility answer per checkout; "unknown" is never kept, so it is asked again. */
  const visibility = new Map<string, { digest: string; value: "private" | "public"; checkedAt: number }>();
  let homeDirs: Promise<string[]> | null = null;

  const local = (ctx: RepoContext, signal?: AbortSignal, env?: Record<string, string>) => ({ cwd: ctx.root, timeoutMs: localTimeoutMs, maxOutputBytes, signal, env });
  const network = (ctx: RepoContext, signal?: AbortSignal) => ({ cwd: ctx.root, timeoutMs: networkTimeoutMs, maxOutputBytes, signal });

  async function realRoot(repo: string): Promise<string> {
    if (typeof repo !== "string" || !isAbsolute(repo)) throw new Error("repo must be an absolute path to a worktree root");
    return realpath(resolve(repo));
  }

  /** Reads the repository layout without writing anything. */
  async function locate(real: string): Promise<{ gitDir: string; common: string; format: "sha1" | "sha256" }> {
    const probe = createGitRunner({ gitPath: options.gitPath, hooksDir: devNull, env: options.gitEnv });
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
      git: createGitRunner({ gitPath: options.gitPath, hooksDir: folder.hooksDir, env: options.gitEnv }),
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

  async function remoteUrls(ctx: RepoContext, name: string, signal?: AbortSignal): Promise<{ fetch: string; push: string } | null> {
    const fetch = await ctx.git.run(["remote", "get-url", name], local(ctx, signal));
    const push = await ctx.git.run(["remote", "get-url", "--push", name], local(ctx, signal));
    if (fetch.code !== 0 || push.code !== 0) return null;
    return { fetch: fetch.stdout.toString("utf8").trim(), push: push.stdout.toString("utf8").trim() };
  }

  interface Enabled {
    record: EnablementRecord;
    pushUrl: string;
  }

  /** The enablement record must exist and still match the folder's real path and the remote's URLs. */
  async function enablementState(ctx: RepoContext, signal?: AbortSignal): Promise<{ enabled: Enabled } | { block: BackupBlock }> {
    const record = await readEnablement(ctx.folder.enablementFile);
    if (!record) return { block: notEnabled() };
    if (record.realPath !== ctx.root) return { block: block("enablement-stale", "this folder was moved or renamed after automatic backup was turned on; turn it on again here") };
    const urls = await remoteUrls(ctx, record.remote, signal);
    if (!urls) return { block: block("enablement-stale", "the backup remote is no longer configured; turn automatic backup on again") };
    if (urlDigest(urls.fetch) !== record.fetchUrlDigest || urlDigest(urls.push) !== record.pushUrlDigest) {
      return { block: block("enablement-stale", "the backup remote's address changed after automatic backup was turned on; turn it on again") };
    }
    return { enabled: { record, pushUrl: urls.push } };
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

  /** Scans the blobs this push would add; any doubt holds the push back. */
  async function scanForPush(ctx: RepoContext, tip: string, remoteName: string, signal?: AbortSignal): Promise<{ notScanned: NotScannedBlob[] } | { block: BackupBlock }> {
    const record = await loadRecord(ctx.folder);
    const known: string[] = [];
    const verified = record.lastVerifiedSnapshot;
    if (verified) {
      const present = await ctx.git.run(["cat-file", "-e", `${verified}^{commit}`], local(ctx, signal));
      if (present.code === 0) known.push(verified);
    }
    let collected;
    try {
      collected = await collectPushBlobs({ git: ctx.git, run: local(ctx, signal), newTip: tip, remoteKnown: known, remoteTrackingGlob: `refs/remotes/${remoteName}/*`, maxBlobBytes: maxScanBlobBytes, maxTotalBytes: maxScanTotalBytes });
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
    const run = previous.catch(() => undefined).then(() => withFolderLock(ctx.folder, { waitMs: lockWaitMs, staleMs: 10 * 60_000 }, fn));
    queues.set(key, run.catch(() => undefined));
    return run;
  }

  async function latest(ctx: RepoContext, signal?: AbortSignal): Promise<{ ref: string; oid: string } | null> {
    const out = await ctx.git.ok(["for-each-ref", "--format=%(objectname) %(refname)", ctx.prefix], local(ctx, signal));
    return latestDayRef(out.toString("utf8").split("\n").filter(Boolean), ctx.prefix);
  }

  async function treeEntries(ctx: RepoContext, commit: string, signal?: AbortSignal): Promise<Map<string, TreeEntry>> {
    const entries = new Map<string, TreeEntry>();
    const out = await ctx.git.ok(["ls-tree", "-r", "-z", "--full-tree", commit], local(ctx, signal));
    for (const record of splitNul(out)) {
      const tab = record.indexOf("\t");
      const [mode, type, oid] = record.slice(0, tab).split(" ");
      if (type !== "blob" || !mode || !oid) continue;
      entries.set(record.slice(tab + 1), { mode, oid });
    }
    return entries;
  }

  function blobOid(ctx: RepoContext, content: Buffer): string {
    return createHash(ctx.objectFormat).update(`blob ${content.length}\0`).update(content).digest("hex");
  }

  async function persist(ctx: RepoContext, change: (record: DeadlineRecord) => DeadlineRecord): Promise<DeadlineRecord> {
    const next = change(await loadRecord(ctx.folder));
    await saveRecord(ctx.folder, next);
    return next;
  }

  async function recordError(ctx: RepoContext, kind: BackupErrorRecord["kind"], message: string): Promise<void> {
    await persist(ctx, (record) => withError(record, { kind, at: now(), message: message.slice(0, 2000) }));
  }

  async function captureLocked(ctx: RepoContext, scope: BackupScope, signal?: AbortSignal): Promise<CaptureResult> {
    const compiled = compileScope(scope);
    const startedAt = now();
    const previous = await latest(ctx, signal);
    const todayRef = backupRef(machineId, ctx.checkoutId, startedAt);
    // If the clock moved back behind the newest day branch, keep appending to that branch.
    const ref = previous && previous.ref > todayRef ? previous.ref : todayRef;
    const prevEntries = previous ? await treeEntries(ctx, previous.oid, signal) : new Map<string, TreeEntry>();

    const { files, skipped } = await listScope(ctx.root, compiled);
    const listed = new Set(files);
    const result: CaptureResult = { committed: false, snapshot: previous?.oid ?? null, ref: previous?.ref ?? null, startedAt, added: [], modified: [], removed: [], pending: [], skipped: [...skipped] };
    const updates: string[] = [];
    const writes: { oid: string; content: Buffer }[] = [];
    const readPaths: string[] = [];
    const cleared: string[] = [];
    const pendingSet = new Set<string>();

    for (const path of files) {
      signal?.throwIfAborted();
      const abs = join(ctx.root, ...path.split("/"));
      const before = prevEntries.get(path);
      const cached = ctx.cache.get(path);
      let entry: { oid: string; mode: GitFileMode } | null = null;
      // Checked before the cache too: a cached stat key must not vouch for a path now reached through a link.
      const contained = await checkContainment(ctx.root, abs);
      if (contained !== "ok") {
        ctx.cache.delete(path);
        listed.delete(path);
        cleared.push(path);
        if (contained === "beyond-symlink") result.skipped.push({ path, reason: "beyond-symlink" });
        continue;
      }
      // The cache only short-cuts files already in the previous snapshot, so their blob is known to exist.
      if (cached && before && before.oid === cached.oid) {
        try {
          const s = await lstat(abs, { bigint: true });
          if (statKey(s) === cached.key) entry = { oid: cached.oid, mode: cached.mode };
        } catch { /* fall through to a full read */ }
        if (!entry) ctx.cache.delete(path);
      }
      if (!entry) {
        const read = await readStable(abs, { settleMs, retries, maxFileBytes, root: ctx.root });
        if (!read.ok) {
          if (read.reason === "missing" || read.reason === "beyond-symlink") {
            listed.delete(path);
            cleared.push(path);
            if (read.reason === "beyond-symlink") result.skipped.push({ path, reason: "beyond-symlink" });
            continue;
          }
          result.pending.push({ path, reason: read.reason });
          pendingSet.add(path);
          continue;
        }
        const oid = blobOid(ctx, read.content);
        entry = { oid, mode: read.mode };
        if (Date.now() - read.changedAtMs >= Math.max(settleMs, CACHE_MIN_AGE_MS)) ctx.cache.set(path, { key: read.key, oid, mode: read.mode });
        if (!before || before.oid !== oid) writes.push({ oid, content: read.content });
      }
      readPaths.push(path);
      if (!before) result.added.push(path);
      else if (before.oid !== entry.oid || before.mode !== entry.mode) result.modified.push(path);
      else continue;
      updates.push(`${entry.mode} ${entry.oid}\t${path}\0`);
    }
    for (const path of prevEntries.keys()) {
      if (listed.has(path)) continue;
      result.removed.push(path);
      updates.push(`0 ${ctx.zeroOid}\t${path}\0`);
    }
    const record = await loadRecord(ctx.folder);
    for (const path of Object.keys(record.pendingSince)) if (!listed.has(path)) cleared.push(path);

    const sawChange = updates.length > 0 || result.pending.length > 0;
    if (updates.length > 0) {
      for (const write of writes) {
        const written = (await ctx.git.ok(["hash-object", "-w", "--no-filters", "--stdin"], { ...local(ctx, signal), input: write.content })).toString("utf8").trim();
        if (written !== write.oid) throw new Error("object store returned an unexpected blob id");
      }
      const indexEnv = { GIT_INDEX_FILE: ctx.folder.indexFile };
      await rm(`${ctx.folder.indexFile}.lock`, { force: true }); // stale only: the folder lock is held
      await ctx.git.ok(previous ? ["read-tree", previous.oid] : ["read-tree", "--empty"], local(ctx, signal, indexEnv));
      await ctx.git.ok(["update-index", "-z", "--index-info"], { ...local(ctx, signal, indexEnv), input: Buffer.from(updates.join(""), "utf8") });
      const tree = (await ctx.git.ok(["write-tree"], local(ctx, signal, indexEnv))).toString("utf8").trim();
      const prevTree = previous ? (await ctx.git.ok(["rev-parse", "--verify", `${previous.oid}^{tree}`], local(ctx, signal))).toString("utf8").trim() : null;
      if (tree !== prevTree) {
        const parents: string[] = [];
        if (previous) parents.push("-p", previous.oid);
        const head = await ctx.git.run(["rev-parse", "-q", "--verify", "HEAD^{commit}"], local(ctx, signal));
        const headOid = head.code === 0 ? head.stdout.toString("utf8").trim() : null;
        if (headOid && headOid !== previous?.oid) {
          let ancestor = false;
          if (previous) {
            const check = await ctx.git.run(["merge-base", "--is-ancestor", headOid, previous.oid], local(ctx, signal));
            if (check.code !== 0 && check.code !== 1) throw new GitProcessError("exit", "could not compare HEAD with the previous snapshot", check.code, check.stderr);
            ancestor = check.code === 0;
          }
          if (!ancestor) parents.push("-p", headOid);
        }
        const seconds = Math.floor(startedAt / 1000);
        const identity = {
          GIT_AUTHOR_NAME: author.name,
          GIT_AUTHOR_EMAIL: author.email,
          GIT_AUTHOR_DATE: `@${seconds} +0000`,
          GIT_COMMITTER_NAME: author.name,
          GIT_COMMITTER_EMAIL: author.email,
          GIT_COMMITTER_DATE: `@${seconds} +0000`,
        };
        const message = `Automatic backup ${new Date(startedAt).toISOString()}\n\nmachine: ${machineId}\ncheckout: ${ctx.checkoutId}\nchanged: ${result.added.length} added, ${result.modified.length} modified, ${result.removed.length} removed\n`;
        const commit = (await ctx.git.ok(["commit-tree", "--no-gpg-sign", tree, ...parents, "-m", message], local(ctx, signal, identity))).toString("utf8").trim();
        const expectedOld = previous && previous.ref === ref ? previous.oid : ctx.zeroOid;
        await ctx.git.ok(["update-ref", "-m", "automatic backup snapshot", ref, commit, expectedOld], local(ctx, signal));
        result.committed = true;
        result.snapshot = commit;
        result.ref = ref;
      }
    }
    if (result.snapshot && result.ref) {
      const snapshot = result.snapshot;
      const snapshotRef = result.ref;
      await persist(ctx, (r) => applyCapture(r, { snapshot, ref: snapshotRef, startedAt, sawChange, readPaths, pendingPaths: [...pendingSet], clearedPaths: cleared }));
    } else if (sawChange) {
      await persist(ctx, (r) => noteEditInRecord(r, startedAt));
    }
    return result;
  }

  async function hooksNotRun(ctx: RepoContext): Promise<string[]> {
    const probe = createGitRunner({ gitPath: options.gitPath, hooksDir: ctx.folder.hooksDir, env: options.gitEnv });
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

  return {
    async enable(repo, opts = {}) {
      const real = await realRoot(repo);
      const where = await locationBlock(real);
      if (where) throw new BackupRefusedError(where);
      const name = opts.remote ?? remote;
      if (!REMOTE_NAME.test(name)) throw new Error("remote must be the name of a configured remote");
      const confirmed = opts.visibilityConfirmedPublic === true;
      const ctx = await context(real);
      return exclusive(ctx, async (): Promise<EnableResult> => {
        const urls = await remoteUrls(ctx, name);
        if (!urls) throw new Error(`remote ${name} is not configured in this repository`);
        const pushUrlDigest = urlDigest(urls.push);
        const seen = await checkVisibility(ctx, pushUrlDigest, urls.push, true);
        if (seen === "public" && !confirmed) throw new BackupRefusedError(visibilityBlock(seen, false)!);
        await writeEnablement(ctx.folder.enablementFile, {
          schema: 1,
          realPath: ctx.root,
          remote: name,
          fetchUrlDigest: urlDigest(urls.fetch),
          pushUrlDigest,
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
          return await captureLocked(ctx, scope, opts.signal);
        } catch (error) {
          await recordError(ctx, "capture-failed", (error as Error).message).catch(() => undefined);
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
        const { record: enabled, pushUrl } = state.enabled;
        const seen = await checkVisibility(ctx, enabled.pushUrlDigest, pushUrl, false);
        const hidden = visibilityBlock(seen, enabled.visibilityConfirmedPublic);
        if (hidden) return holdPush(ctx, hidden);
        const current = await latest(ctx, opts.signal);
        if (!current) return { state: "no-snapshot", message: "no backup snapshot has been captured yet" };
        const scanned = await scanForPush(ctx, current.oid, enabled.remote, opts.signal);
        if ("block" in scanned) return holdPush(ctx, scanned.block);
        const target = enabled.remote;
        let result;
        try {
          result = await ctx.git.run(["push", "--porcelain", "--no-follow-tags", "--no-signed", "--recurse-submodules=no", target, `${current.ref}:${current.ref}`], network(ctx, opts.signal));
        } catch (error) {
          const message = (error as Error).message;
          await recordError(ctx, "push-failed", message);
          return { state: "failed", ref: current.ref, snapshot: current.oid, message };
        }
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
        return { state: flag === "=" ? "up-to-date" : "pushed", ref: current.ref, snapshot: current.oid, notScanned: scanned.notScanned };
      });
    },

    async verify(repo, opts = {}) {
      const admitted = await admit(repo);
      if ("block" in admitted) return { verified: false, state: "blocked", reason: admitted.block.reason, message: admitted.block.message };
      const { ctx } = admitted;
      return exclusive(ctx, async (): Promise<VerifyResult> => {
        const state = await enablementState(ctx, opts.signal);
        if ("block" in state) return { verified: false, state: "blocked", reason: state.block.reason, message: state.block.message };
        const target = state.enabled.record.remote;
        const record = await loadRecord(ctx.folder);
        const pushed = record.lastPushed;
        if (!pushed) return { verified: false, state: "not-pushed" };
        let out;
        try {
          out = await ctx.git.ok(["ls-remote", "--refs", target, pushed.ref], network(ctx, opts.signal));
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

    async noteEdit(repo, time) {
      const ms = time instanceof Date ? time.getTime() : time;
      if (!Number.isFinite(ms)) throw new Error("edit time must be a Date or finite milliseconds");
      const ctx = await context(await realRoot(repo));
      await exclusive(ctx, () => persist(ctx, (r) => noteEditInRecord(r, ms)));
    },

    async status(repo, opts = {}) {
      const real = await realRoot(repo);
      const where = await locationBlock(real);
      const ctx = await context(real);
      return exclusive(ctx, async (): Promise<BackupStatus> => {
        const record = await loadRecord(ctx.folder);
        const current = await latest(ctx, opts.signal);
        const state = await enablementState(ctx, opts.signal);
        // Live guards first, then the cached visibility answer (no network here), then the last held-back push.
        let held: BackupBlock | null = where ?? ("block" in state ? state.block : null);
        if (!held && "enabled" in state) {
          const cached = visibility.get(ctx.folder.dir);
          if (cached && cached.digest === state.enabled.record.pushUrlDigest) held = visibilityBlock(cached.value, state.enabled.record.visibilityConfirmedPublic);
        }
        held ??= record.lastBlock ?? null;
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
