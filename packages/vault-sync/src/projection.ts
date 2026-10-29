/**
 * Optional trusted capture projection: a host-supplied cohort of files that capture inserts into its
 * private index as one unit, beside the ordinary scoped files. Without a projection capture is unchanged.
 *
 * The engine owns path authority and the transaction; the host owns what the files mean.
 * - The projection declares narrow owned namespaces: exact worktree-relative file paths, or folders
 *   written with a trailing "/". Every projected path must lie in one of them. A namespace path may not
 *   also be captured by the ordinary scope, and an ordinary listed file may not lie in a namespace.
 * - `read` returns the complete cohort or "unavailable". A complete cohort replaces the previous one in
 *   the snapshot: previous paths in the namespaces that are not in it are removed. An empty complete
 *   cohort is a real answer (nothing to project); "unavailable" holds the whole capture back with the
 *   block "history-unavailable", so the previous snapshot and its cohort stay as they were and nothing
 *   new is credited.
 * - Each projected path must be a plain Git path inside a namespace, given once, no larger than the
 *   capture's file limit, and its location in the worktree must be reached without a symlink. Anything
 *   else makes the cohort unavailable.
 * - Projected files are never editor reads: they do not enter the capture's read paths, read object ids or
 *   confirmed deletions, so they cannot settle an edit, a save receipt or a write guard. They are blobs of
 *   the snapshot like any other, so the push's size limits and secret scan cover them.
 * - Filtering a later cohort never removes anything from earlier snapshots: their ancestry is immutable.
 * - The engine owns the wait (projectionAttempt): one attempt is the host's read AND the cohort check,
 *   under one finite budget that races the caller's abort, whatever the host or the file system does. An
 *   already aborted caller never calls `read`; the budget timer and the abort listener are in place before
 *   `read` is called (an abort caused from inside `read` still counts); an answer or check result that
 *   comes after the deadline (monotonic clock, checked again when it settles, empty cohorts included) or
 *   the abort is ignored, so it can neither publish nor credit anything, and the operation lock is
 *   released without it. The host gets a signal that fires at either end. The cohort check is bounded
 *   too: its file count, each file and all files together (journals included), and the budget is checked
 *   again after every await of it.
 * - Admission is of the work, not of the wait: per projection name and folder, at most ONE attempt's
 *   underlying work (the host's read and the check after it) runs at a time. Its slot is held until that
 *   work has really ended, not when its caller stopped waiting; a new attempt while it still runs is
 *   unavailable at once, without calling the host. So timeouts and aborts cannot pile up running reads.
 *   Synchronous work that blocks the event loop cannot be pre-empted in-process (the helper process and
 *   its supervisor are the outer bound).
 */
import { join } from "node:path";
import { compileScope, type BackupScope } from "./scope.ts";
import { checkContainment } from "./stable-read.ts";

export interface ProjectedFile {
  /** Worktree-relative POSIX path inside a declared namespace. */
  path: string;
  content: Buffer;
}

export type ProjectionRead =
  /** `summary`: counts the host reports with a preview (for example named versions); never trusted for paths. */
  | { state: "complete"; files: ProjectedFile[]; summary?: Record<string, number> }
  | { state: "unavailable"; reason: string };

/** One projection attempt's time budget, preview and capture alike (the first capture pass included). */
export const PROJECTION_BUDGET_MS = 60_000;
/** All projected bytes of one cohort together: the push secret scan's own total limit. */
export const PROJECTED_TOTAL_LIMIT = 512 * 1024 * 1024;

export interface CaptureProjection {
  /** Short name reported with a refusal (for example "writeflex-named-versions"). */
  name: string;
  /** Owned output paths: exact files, or folders ending in "/". */
  namespaces: readonly string[];
  /** Reads one coherent cohort from the worktree root. Must not write anything. */
  read(root: string, signal?: AbortSignal): Promise<ProjectionRead>;
}

/** A plain worktree-relative Git path: no empty, "." or ".." parts, no NUL, backslash or ".git" part. */
export function plainGitPath(path: string): boolean {
  if (typeof path !== "string" || path === "" || path.length > 4096 || path.includes("\0") || path.includes("\\") || path.startsWith("/")) return false;
  return path.split("/").every((p) => p !== "" && p !== "." && p !== ".." && p.toLowerCase() !== ".git");
}

/** Validated namespaces; throws on a malformed or overlapping declaration. */
export function checkedNamespaces(namespaces: readonly string[]): string[] {
  if (!Array.isArray(namespaces) || namespaces.length === 0 || namespaces.length > 16) throw new Error("a capture projection must declare 1 to 16 namespaces");
  const out: string[] = [];
  for (const ns of namespaces) {
    const folder = typeof ns === "string" && ns.endsWith("/");
    const bare = folder ? ns.slice(0, -1) : ns;
    if (!plainGitPath(bare)) throw new Error("projection namespaces must be plain worktree-relative paths");
    out.push(ns);
  }
  for (const a of out) for (const b of out) if (a !== b && inNamespace(a.endsWith("/") ? a.slice(0, -1) : a, [b])) throw new Error("projection namespaces may not overlap");
  if (new Set(out).size !== out.length) throw new Error("projection namespaces may not repeat");
  return out;
}

/** Whether the ordinary scope captures `path`: included, with no excluded ancestor (as capture decides). */
export function ordinaryScopeTest(scope: BackupScope | ReturnType<typeof compileScope>): (path: string) => boolean {
  const compiled = "isIncluded" in scope ? scope : compileScope(scope);
  return (path) => {
    const parts = path.split("/");
    return compiled.isIncluded(path) && !parts.some((_, i) => compiled.isExcluded(parts.slice(0, i + 1).join("/")));
  };
}

export function inNamespace(path: string, namespaces: readonly string[]): boolean {
  return namespaces.some((ns) => (ns.endsWith("/") ? path.startsWith(ns) && path.length > ns.length : path === ns));
}

export type CheckedCohort = { files: ProjectedFile[] } | { unavailable: string };

/** Projection name + folder of every attempt whose underlying work is still running (one each at most). */
const running = new Set<string>();

/** For tests: how many attempts' underlying work is still running. */
export function runningProjectionWork(): number {
  return running.size;
}

/**
 * One admitted attempt: `work` runs at most once per projection name and folder at a time, its slot held
 * until it has really settled. The caller gets `work`'s answer, its abort reason, or `unavailable(why)`
 * when the budget ends first or an earlier attempt's work still runs; never anything later.
 * - The budget timer and the abort listener exist before `work` (the host's code) is called, so an abort
 *   the host itself causes while it is being called reaches the inner signal and settles the caller at once.
 * - An answer is used only when it came before the deadline (monotonic clock, checked when it settles):
 *   synchronous work cannot be pre-empted, but its late answer is refused, empty cohort included.
 */
function admitted<T>(projection: CaptureProjection, root: string, opts: { signal?: AbortSignal; budgetMs: number }, unavailable: (reason: string) => T, work: (signal: AbortSignal, deadline: number) => Promise<T>): Promise<T> {
  const { signal, budgetMs } = opts;
  signal?.throwIfAborted();
  if (!(budgetMs > 0)) return Promise.resolve(unavailable("no time was left to read the projection"));
  const key = `${projection.name}\0${root}`;
  if (running.has(key)) return Promise.resolve(unavailable("an earlier read of it for this folder has not ended yet"));
  const late = () => unavailable(`the projection did not answer within ${Math.ceil(budgetMs / 1000)} s`);
  const inner = new AbortController();
  const deadline = performance.now() + budgetMs;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      settle();
    };
    const onAbort = () => {
      inner.abort(signal!.reason);
      finish(() => reject(signal!.reason));
    };
    const timer = setTimeout(() => {
      inner.abort(new Error("the projection's time budget ended"));
      finish(() => resolve(late()));
    }, Math.max(0, deadline - performance.now()));
    signal?.addEventListener("abort", onAbort, { once: true });
    // Checked again once connected: an abort that came before the listener never calls the host.
    if (signal?.aborted) return onAbort();
    running.add(key);
    // Only now the host's code runs; the slot is released when its work has really ended.
    const underlying = (async () => {
      try {
        return await work(inner.signal, deadline);
      } finally {
        running.delete(key);
      }
    })();
    underlying.then(
      (answer) => finish(() => resolve(performance.now() >= deadline ? late() : answer)),
      (error) => finish(() => resolve(unavailable(`the projection failed (${String((error as Error)?.message ?? error).slice(0, 200)})`))),
    );
  });
}

/** The host's answer as one admitted call (a host that throws at once fails like one that rejects). */
async function hostRead(projection: CaptureProjection, root: string, signal: AbortSignal): Promise<ProjectionRead> {
  return projection.read(root, signal);
}

/**
 * The host's read alone under the same admission and budget (preview summaries, tests). Throws the
 * caller's abort reason when `signal` aborts first; answers "unavailable" when the host fails, the budget
 * ends first or an earlier read for the folder still runs.
 */
export function readProjection(projection: CaptureProjection, root: string, opts: { signal?: AbortSignal; budgetMs: number }): Promise<ProjectionRead> {
  return admitted<ProjectionRead>(projection, root, opts, (reason) => ({ state: "unavailable", reason }), (signal) => hostRead(projection, root, signal));
}

/**
 * One whole attempt, as capture and preview use it: the host's read, then checkCohort on its answer, both
 * inside one budget and one admission slot. `answer` is the host's answer when it came in time (a
 * preview reports its summary).
 */
export function projectionAttempt(projection: CaptureProjection, root: string, namespaces: readonly string[], limits: { maxFileBytes: number; maxFiles?: number; maxTotalBytes?: number }, ordinary: (path: string) => boolean, opts: { signal?: AbortSignal; budgetMs: number }): Promise<CheckedCohort & { answer?: ProjectionRead }> {
  return admitted<CheckedCohort & { answer?: ProjectionRead }>(projection, root, opts, (reason) => ({ unavailable: reason }), async (signal, deadline) => {
    let answer: ProjectionRead;
    try {
      answer = await hostRead(projection, root, signal);
    } catch (error) {
      return { unavailable: `the projection failed (${String((error as Error)?.message ?? error).slice(0, 200)})` };
    }
    signal.throwIfAborted();
    // A host that answered (or blocked the event loop) past the deadline: its answer is not checked or used.
    if (performance.now() >= deadline) return { unavailable: "the projection did not answer within its time budget" };
    return { ...(await checkCohort(root, namespaces, answer, limits, ordinary, { signal, deadline })), answer };
  });
}

/**
 * The cohort as capture may insert it, or why it is unavailable. `ordinary(path)` says whether the
 * ordinary scope would capture `path`. Low level: it checks `bound` between and after its awaits, but an
 * await that never settles holds it; capture and preview call it only inside projectionAttempt, whose
 * budget and admission bound it.
 */
export async function checkCohort(root: string, namespaces: readonly string[], read: ProjectionRead, limits: { maxFileBytes: number; maxFiles?: number; maxTotalBytes?: number }, ordinary: (path: string) => boolean, bound: { signal?: AbortSignal; deadline?: number } = {}): Promise<CheckedCohort> {
  if (!read || typeof read !== "object") return { unavailable: "the projection gave no answer" };
  if (read.state === "unavailable") return { unavailable: String(read.reason ?? "unavailable").slice(0, 300) };
  if (read.state !== "complete" || !Array.isArray(read.files)) return { unavailable: "the projection gave an answer capture cannot check" };
  const maxFiles = limits.maxFiles ?? 100_000;
  if (read.files.length > maxFiles) return { unavailable: `the projection has more than ${maxFiles} files` };
  const maxTotal = limits.maxTotalBytes ?? PROJECTED_TOTAL_LIMIT;
  const deadline = bound.deadline ?? Infinity;
  const seen = new Set<string>();
  const files: ProjectedFile[] = [];
  let total = 0;
  for (const file of read.files) {
    bound.signal?.throwIfAborted();
    if (performance.now() >= deadline) return { unavailable: "the projection could not be checked within its time budget" };
    const path = file?.path;
    if (typeof path !== "string" || !plainGitPath(path)) return { unavailable: "the projection named a path that is not a plain worktree path" };
    if (!inNamespace(path, namespaces)) return { unavailable: "the projection named a path outside its namespaces" };
    if (seen.has(path)) return { unavailable: "the projection named a path twice" };
    if (ordinary(path)) return { unavailable: "a projected path is also in the ordinary backup scope" };
    if (!Buffer.isBuffer(file.content)) return { unavailable: "the projection gave content that is not bytes" };
    if (file.content.length > limits.maxFileBytes) return { unavailable: "a projected file is larger than the capture limit" };
    total += file.content.length;
    if (total > maxTotal) return { unavailable: "the projected files are larger in total than the capture limit" };
    // Its place in the worktree must be reached without a link, so a projection can never stand for bytes outside.
    const contained = await checkContainment(root, join(root, ...path.split("/")));
    // A check that answered after the budget or the abort is not used.
    bound.signal?.throwIfAborted();
    if (performance.now() >= deadline) return { unavailable: "the projection could not be checked within its time budget" };
    if (contained !== "ok") return { unavailable: contained === "beyond-symlink" ? "a projected path lies beyond a symlink" : `a projected path is ${contained}` };
    seen.add(path);
    files.push({ path, content: file.content });
  }
  // Every success, an empty cohort included, is checked against the deadline last.
  bound.signal?.throwIfAborted();
  if (performance.now() >= deadline) return { unavailable: "the projection could not be checked within its time budget" };
  return { files };
}
