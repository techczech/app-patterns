// Folder watcher rule (taken from WriteFlex `workspace-watcher.ts`). Raw events from a recursive
// watch collapse into sorted bursts of vault-relative paths; ignored paths are dropped; the app's own
// writes are suppressed.
//
// Own-write suppression is by path AND the hash the app wrote (WriteFlex used the path alone): a
// foreign write to the same path within the window is still reported, because the file then holds
// other bytes than the app wrote.

import { watch, type FSWatcher } from 'node:fs'
import { isAbsolute, posix } from 'node:path'
import { TEMP_SUFFIX } from './guarded-write.ts'

export const OWN_WRITE_DEDUPE_MS = 5_000
export const WATCH_BURST_DEBOUNCE_MS = 220

export function normaliseWatchPath(path: string): string {
  return posix.normalize(path.replaceAll('\\', '/'))
}

/** Short-lived record of files the app itself wrote: path and the sha256 of the bytes written. */
export class OwnWriteTracker {
  readonly #writes = new Map<string, { at: number; sha256: string }>()
  constructor(readonly windowMs = OWN_WRITE_DEDUPE_MS) {}

  record(path: string, sha256: string, at = Date.now()): void {
    this.#writes.set(normaliseWatchPath(path), { at, sha256 })
  }

  /** Whether the app wrote `path` within the window. */
  isRecent(path: string, at = Date.now()): boolean {
    const key = normaliseWatchPath(path)
    const written = this.#writes.get(key)
    if (!written) return false
    if (at - written.at <= this.windowMs) return true
    this.#writes.delete(key)
    return false
  }

  /** Whether the file at `path` now holding bytes with `currentSha256` is the app's own recent write. */
  isOwnWrite(path: string, currentSha256: string | null, at = Date.now()): boolean {
    if (!this.isRecent(path, at)) return false
    return currentSha256 !== null && this.#writes.get(normaliseWatchPath(path))?.sha256 === currentSha256
  }
}

/**
 * Default ignore rule: absolute or escaping paths; any segment starting with `.` (app folders, temp
 * files) except paths in `allow`; temp files this package makes.
 */
export function createIgnoreRule(allow: readonly string[] = []): (path: string) => boolean {
  const allowed = new Set(allow.map(normaliseWatchPath))
  return (path) => {
    if (!path || isAbsolute(path)) return true
    const normalised = normaliseWatchPath(path)
    if (normalised === '.' || normalised === '..' || normalised.startsWith('../')) return true
    if (normalised.endsWith(TEMP_SUFFIX) || normalised.endsWith('.tmp')) return true
    if (allowed.has(normalised)) return false
    return normalised.split('/').some((segment) => segment.startsWith('.'))
  }
}

export type WatchRouterDeps = {
  /** True for a path the app never reports. Default: createIgnoreRule(). */
  ignore?: (path: string) => boolean
  /** The app's own writes. Absent: nothing is suppressed. */
  ownWrites?: OwnWriteTracker
  /** The sha256 of the file at vault-relative `path` now, or null when it is not a readable file.
   *  Needed to suppress own writes; asked only for paths written recently. */
  hashOf?: (path: string) => Promise<string | null>
}

export type WatchRouter = { take: (filename: string) => void; flushNow: () => Promise<void>; dispose: () => void }

/**
 * The watcher's rule apart from the native watch, so it can be tested: ignored paths are dropped,
 * every other path is collected into a burst for `onChanged` (sorted), unless the file holds exactly
 * what the app wrote there within the window.
 */
export function createWatchRouter(
  deps: WatchRouterDeps,
  onChanged: (paths: string[]) => void,
  debounceMs = WATCH_BURST_DEBOUNCE_MS,
): WatchRouter {
  const ignore = deps.ignore ?? createIgnoreRule()
  const pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const flush = async (): Promise<void> => {
    timer = null
    if (disposed || pending.size === 0) return
    const paths = [...pending].sort((a, b) => a.localeCompare(b))
    pending.clear()
    const reported: string[] = []
    for (const path of paths) {
      if (deps.ownWrites?.isRecent(path) && deps.hashOf) {
        let hash: string | null = null
        try { hash = await deps.hashOf(path) } catch { hash = null }
        if (deps.ownWrites.isOwnWrite(path, hash)) continue
      }
      reported.push(path)
    }
    if (!disposed && reported.length) onChanged(reported)
  }

  return {
    take: (filename) => {
      if (disposed || !filename) return
      const path = normaliseWatchPath(String(filename))
      if (ignore(path)) return
      pending.add(path)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => { void flush() }, debounceMs)
    },
    flushNow: async () => {
      if (timer) clearTimeout(timer)
      await flush()
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      if (timer) clearTimeout(timer)
      timer = null
      pending.clear()
    },
  }
}

export type FolderWatcher = { dispose: () => void }

/**
 * Native recursive watcher over `root` feeding `router`. `onError` runs once when the watcher stops on
 * an error (the app then relies on focus and save-time checks). Throws when the folder cannot be
 * watched at all.
 */
export function createFolderWatcher(root: string, router: WatchRouter, onError: (error: unknown) => void = () => {}): FolderWatcher {
  let disposed = false
  const watcher: FSWatcher = watch(root, { recursive: true, encoding: 'utf8' }, (_event, filename) => {
    if (!disposed && filename) router.take(String(filename))
  })
  watcher.on('error', (error) => {
    if (disposed) return
    disposed = true
    router.dispose()
    try { watcher.close() } catch { /* already closed */ }
    onError(error)
  })
  return {
    dispose: () => {
      if (disposed) return
      disposed = true
      router.dispose()
      watcher.close()
    },
  }
}
