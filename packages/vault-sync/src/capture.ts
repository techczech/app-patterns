/**
 * Snapshot capture: lists the scope, reads each file stably, and commits a tree built in the checkout's
 * private index with the previous snapshot as its only parent. The previous snapshot's chain must be one
 * this engine made (chain.ts); otherwise capture stops with "unsupported-history" before extending it.
 * Files that cannot be read, or sit in a folder that cannot be listed, keep their previous version and
 * are reported as pending; a folder in scope that cannot be listed is itself reported as pending, because
 * files never captured may be in it. A coordinated write that was in progress, started or finished at any
 * time while the capture was reading (its mark's generation changed between the record read before the
 * files and the one after) keeps the previous version too. A path absent from the listing is recorded as
 * deleted only after a direct check confirms it is gone. The commit message carries the coverage claim
 * (snapshot-message.ts), and the deadline record is settled in the same step (deadline.ts).
 */
import { createHash } from "node:crypto";
import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { backupRef, latestDayRef } from "./backup-ref.ts";
import { BackupRefusedError } from "./blocks.ts";
import { chainProblem, recordRoot } from "./chain.ts";
import { applyCapture, coverageOfCapture, markPending, type CaptureOutcome, type DeadlineRecord } from "./deadline.ts";
import type { EngineFolder } from "./engine-store.ts";
import { splitNul, type GitRunner, type GitRunOptions } from "./git-process.ts";
import { compileScope, listScope, underAny, type BackupScope, type SkippedPath } from "./scope.ts";
import { formatSnapshotMessage } from "./snapshot-message.ts";
import { checkContainment, readStable, statKey, type GitFileMode } from "./stable-read.ts";

export interface PendingFile {
  path: string;
  /**
   * "writing": a coordinated writer's in-place write was in progress, or started or finished, while the
   * capture read. "unlisted": `path` is a folder in scope that could not be listed, or an include path
   * that could not be checked ("." for the worktree root); files in it may never have been captured.
   */
  reason: "unstable" | "too-large" | "unreadable" | "writing" | "unlisted";
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

export interface RepoContext {
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

export interface CaptureDeps {
  machineId: string;
  now: () => number;
  settleMs: number;
  retries: number;
  maxFileBytes: number;
  author: { name: string; email: string };
  /** Options for a local git call in this checkout. */
  run(ctx: RepoContext, signal?: AbortSignal, env?: Record<string, string>): GitRunOptions;
  readRecord(ctx: RepoContext): Promise<DeadlineRecord>;
  persist(ctx: RepoContext, change: (record: DeadlineRecord) => DeadlineRecord): Promise<DeadlineRecord>;
}

const CACHE_MIN_AGE_MS = 2000;

/** The newest backup ref of this checkout and its snapshot, or null. */
export async function latestSnapshot(ctx: RepoContext, run: GitRunOptions): Promise<{ ref: string; oid: string } | null> {
  const out = await ctx.git.ok(["for-each-ref", "--format=%(objectname) %(refname)", ctx.prefix], run);
  return latestDayRef(out.toString("utf8").split("\n").filter(Boolean), ctx.prefix);
}

async function treeEntries(ctx: RepoContext, commit: string, run: GitRunOptions): Promise<Map<string, TreeEntry>> {
  const entries = new Map<string, TreeEntry>();
  const out = await ctx.git.ok(["ls-tree", "-r", "-z", "--full-tree", commit], run);
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

/**
 * Takes one snapshot of the scoped files with the checkout's private index. The caller holds the
 * operation lock. HEAD, the user's index and the worktree are never written; only the backup ref moves.
 */
export async function captureSnapshot(ctx: RepoContext, scope: BackupScope, deps: CaptureDeps, signal?: AbortSignal): Promise<CaptureResult> {
  const { machineId, now, settleMs, retries, maxFileBytes, author, readRecord, persist } = deps;
  const local = (c: RepoContext, sig?: AbortSignal, env?: Record<string, string>) => deps.run(c, sig, env);
  const compiled = compileScope(scope);
  const startedAt = now();
  const previous = await latestSnapshot(ctx, deps.run(ctx, signal));
  const todayRef = backupRef(machineId, ctx.checkoutId, startedAt);
  // If the clock moved back behind the newest day branch, keep appending to that branch.
  const ref = previous && previous.ref > todayRef ? previous.ref : todayRef;
  const prevEntries = previous ? await treeEntries(ctx, previous.oid, deps.run(ctx, signal)) : new Map<string, TreeEntry>();
  if (previous) {
    const problem = await chainProblem(ctx.git, deps.run(ctx, signal), ctx.folder, previous.oid, { email: author.email, machineId, checkoutId: ctx.checkoutId });
    if (problem) throw new BackupRefusedError({ reason: "unsupported-history", at: now(), message: `${problem}; automatic backup does not extend or publish it` });
  }
  // The record before any file is read: its generation orders this capture after every report already in
  // it, and its write marks are compared with the record after the reads.
  const before = await readRecord(ctx);
  const writesBefore = before.writes;

  const { files, skipped, unreadable, listed: listedFolders } = await listScope(ctx.root, compiled);
  const listed = new Set(files);
  const result: CaptureResult = { committed: false, snapshot: previous?.oid ?? null, ref: previous?.ref ?? null, startedAt, added: [], modified: [], removed: [], pending: [], skipped: [...skipped] };
  const read = new Map<string, { oid: string; mode: GitFileMode; content: Buffer | null }>();
  const goneConfirmed: string[] = [];
  const cleared: string[] = [];
  const pendingSet = new Set<string>();
  const leavePending = (path: string, reason: PendingFile["reason"]) => {
    result.pending.push({ path, reason });
    pendingSet.add(path);
  };

  for (const path of files) {
    signal?.throwIfAborted();
    const abs = join(ctx.root, ...path.split("/"));
    const before = prevEntries.get(path);
    if (writesBefore[path]?.active) {
      ctx.cache.delete(path);
      leavePending(path, "writing");
      continue;
    }
    const cached = ctx.cache.get(path);
    let entry: { oid: string; mode: GitFileMode } | null = null;
    // Checked before the cache too: a cached stat key must not vouch for a path now reached through a link.
    const contained = await checkContainment(ctx.root, abs);
    if (contained === "unreadable") {
      ctx.cache.delete(path);
      leavePending(path, "unreadable");
      continue;
    }
    if (contained !== "ok") {
      ctx.cache.delete(path);
      listed.delete(path);
      cleared.push(path);
      if (contained === "beyond-symlink") result.skipped.push({ path, reason: "beyond-symlink" });
      else goneConfirmed.push(path);
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
    let content: Buffer | null = null;
    if (!entry) {
      const stable = await readStable(abs, { settleMs, retries, maxFileBytes, root: ctx.root });
      if (!stable.ok) {
        if (stable.reason === "missing" || stable.reason === "beyond-symlink") {
          listed.delete(path);
          cleared.push(path);
          if (stable.reason === "beyond-symlink") result.skipped.push({ path, reason: "beyond-symlink" });
          else goneConfirmed.push(path);
          continue;
        }
        leavePending(path, stable.reason);
        continue;
      }
      entry = { oid: blobOid(ctx, stable.content), mode: stable.mode };
      if (Date.now() - stable.changedAtMs >= Math.max(settleMs, CACHE_MIN_AGE_MS)) ctx.cache.set(path, { key: stable.key, oid: entry.oid, mode: stable.mode });
      if (!before || before.oid !== entry.oid) content = stable.content;
    }
    read.set(path, { ...entry, content });
  }
  // Acknowledged paths can disappear before their first snapshot. Even an unchanged tree needs
  // direct absence proof for them, ordered after their acknowledgement and inside the capture scope.
  const absentCandidates = new Set([...prevEntries.keys(), ...before.flushed.flatMap((f) => f.path === null ? [] : [f.path])]);
  const removals = new Set<string>();
  for (const path of absentCandidates) {
    if (listed.has(path)) continue;
    // Persisted records are not path authority. Never probe outside the root or an excluded ancestor.
    const parts = path.split("/");
    if (!path || path.startsWith("/") || path.includes("\0") || parts.some((p) => p === "" || p === "." || p === "..")) continue;
    const inScope = compiled.isIncluded(path) && !parts.some((_, i) => compiled.isExcluded(parts.slice(0, i + 1).join("/")));
    if (inScope && writesBefore[path]?.active) {
      leavePending(path, "writing");
      continue;
    }
    if (inScope && underAny(path, unreadable)) {
      leavePending(path, "unreadable");
      continue;
    }
    if (inScope) {
      // A missing child of a nested repository is outside this engine's scope. An inaccessible or
      // symlinked ancestor cannot supply deletion proof either.
      let boundary = false;
      for (let i = 1; i < parts.length; i++) {
        const parent = join(ctx.root, ...parts.slice(0, i));
        const contained = await checkContainment(ctx.root, join(parent, ".git"));
        if (contained === "beyond-symlink") { boundary = true; break; }
        if (contained === "unreadable") { leavePending(path, "unreadable"); boundary = true; break; }
        try { await lstat(join(parent, ".git")); boundary = true; break; }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "ENOENT" && code !== "ENOTDIR") { leavePending(path, "unreadable"); boundary = true; break; }
        }
      }
      if (!boundary) {
        const gone = await confirmGone(ctx.root, path);
        if (gone === "unreadable") { leavePending(path, "unreadable"); continue; }
        if (gone === "gone" && !goneConfirmed.includes(path)) goneConfirmed.push(path);
      }
    }
    if (prevEntries.has(path) && !pendingSet.has(path)) removals.add(path);
  }
  // Check generations after both reads and absence checks: a write that completed during either
  // invalidates that proof, even when the clock is equal or rolled back and it is no longer active.
  const record = await readRecord(ctx);
  for (const path of new Set([...read.keys(), ...goneConfirmed, ...removals])) {
    const after = record.writes[path];
    const was = writesBefore[path];
    if (!was?.active && !after?.active && (after?.gen ?? null) === (was?.gen ?? null)) continue;
    read.delete(path);
    removals.delete(path);
    for (let i = goneConfirmed.length - 1; i >= 0; i--) if (goneConfirmed[i] === path) goneConfirmed.splice(i, 1);
    ctx.cache.delete(path);
    if (!pendingSet.has(path)) leavePending(path, "writing");
  }
  const updates: string[] = [];
  const writes: { oid: string; content: Buffer }[] = [];
  for (const [path, entry] of read) {
    const before = prevEntries.get(path);
    if (entry.content) writes.push({ oid: entry.oid, content: entry.content });
    if (!before) result.added.push(path);
    else if (before.oid !== entry.oid || before.mode !== entry.mode) result.modified.push(path);
    else continue;
    updates.push(`${entry.mode} ${entry.oid}\t${path}\0`);
  }
  const readPaths = [...read.keys()];
  for (const path of removals) {
    result.removed.push(path);
    updates.push(`0 ${ctx.zeroOid}\t${path}\0`);
  }
  for (const path of Object.keys(record.pendingSince)) if (!listed.has(path) && !pendingSet.has(path)) cleared.push(path);
  // Folders in scope that could not be listed are pending themselves. A folder that was unlisted before
  // stays pending until it is listed or confirmed gone.
  const unlisted = new Set(unreadable);
  const relisted: string[] = [];
  // An include path that was a file is "listed" when the walk found it.
  const listedNow = new Set([...listedFolders, ...files]);
  for (const folder of Object.keys(record.unlistedSince)) {
    if (unlisted.has(folder)) continue;
    if (listedNow.has(folder)) relisted.push(folder);
    else if ((await confirmGone(ctx.root, folder)) !== "gone") unlisted.add(folder);
  }
  for (const folder of [...unlisted].sort()) result.pending.push({ path: folder === "" ? "." : folder, reason: "unlisted" });

  const sawChange = updates.length > 0;
  let tree: string | null = null;
  let prevTree: string | null = null;
  // Exact absence needs a real snapshot to push and verify even before any file was captured.
  // Reuse that root on later unchanged captures; an empty listing alone supplies no proof.
  if (updates.length > 0 || (!previous && goneConfirmed.length > 0)) {
    for (const write of writes) {
      const written = (await ctx.git.ok(["hash-object", "-w", "--no-filters", "--stdin"], { ...local(ctx, signal), input: write.content })).toString("utf8").trim();
      if (written !== write.oid) throw new Error("object store returned an unexpected blob id");
    }
    const indexEnv = { GIT_INDEX_FILE: ctx.folder.indexFile };
    await rm(`${ctx.folder.indexFile}.lock`, { force: true }); // stale only: the folder lock is held
    await ctx.git.ok(previous ? ["read-tree", previous.oid] : ["read-tree", "--empty"], local(ctx, signal, indexEnv));
    await ctx.git.ok(["update-index", "-z", "--index-info"], { ...local(ctx, signal, indexEnv), input: Buffer.from(updates.join(""), "utf8") });
    tree = (await ctx.git.ok(["write-tree"], local(ctx, signal, indexEnv))).toString("utf8").trim();
    if (previous) prevTree = (await ctx.git.ok(["rev-parse", "--verify", `${previous.oid}^{tree}`], local(ctx, signal))).toString("utf8").trim();
  }
  const lastLooked = before.lastCapture?.coverage;
  const outcome: Omit<CaptureOutcome, "snapshot" | "ref"> = {
    startedAt,
    startGen: before.generation,
    // The last time the engine looked; a change it now cannot read may have been made any time since.
    pendingFloor: lastLooked === null || lastLooked === undefined ? startedAt : Math.min(lastLooked, startedAt),
    committed: tree !== null && tree !== prevTree,
    sawChange,
    readPaths,
    goneConfirmed,
    pendingPaths: [...pendingSet],
    clearedPaths: cleared,
    unlistedFolders: [...unlisted].sort(),
    relistedFolders: relisted,
  };
  if (outcome.committed) {
    // Parents are earlier snapshots only (see the invariants above).
    const parents = previous ? ["-p", previous.oid] : [];
    const seconds = Math.floor(startedAt / 1000);
    const identity = {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_AUTHOR_DATE: `@${seconds} +0000`,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
      GIT_COMMITTER_DATE: `@${seconds} +0000`,
    };
    const message = formatSnapshotMessage({ startedAt, machineId, checkoutId: ctx.checkoutId, added: result.added.length, modified: result.modified.length, removed: result.removed.length, coverageThrough: coverageOfCapture(record, outcome), pendingFiles: pendingSet.size, unlistedFolders: unlisted.size });
    const commit = (await ctx.git.ok(["commit-tree", "--no-gpg-sign", tree!, ...parents, "-m", message], local(ctx, signal, identity))).toString("utf8").trim();
    if (!previous) await recordRoot(ctx.folder, commit);
    const expectedOld = previous && previous.ref === ref ? previous.oid : ctx.zeroOid;
    await ctx.git.ok(["update-ref", "-m", "automatic backup snapshot", ref, commit, expectedOld], local(ctx, signal));
    result.committed = true;
    result.snapshot = commit;
    result.ref = ref;
  }
  if (result.snapshot && result.ref) {
    const snapshot = result.snapshot;
    const snapshotRef = result.ref;
    await persist(ctx, (r) => applyCapture(r, { ...outcome, snapshot, ref: snapshotRef }).record);
  } else {
    // No snapshot exists yet: keep the pending marks (and their floors) for the next capture.
    await persist(ctx, (r) => markPending(r, outcome));
  }
  return result;
}

/** Whether a path absent from the listing is really gone: "gone" only for ENOENT or ENOTDIR on the path or a parent. */
async function confirmGone(root: string, path: string): Promise<"gone" | "present" | "unreadable"> {
  const abs = path === "" ? root : join(root, ...path.split("/"));
  const contained = path === "" ? "ok" : await checkContainment(root, abs);
  if (contained === "missing") return "gone";
  if (contained === "unreadable") return "unreadable";
  if (contained === "beyond-symlink") return "present";
  try {
    await lstat(abs);
    return "present";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "gone" : "unreadable";
  }
}
