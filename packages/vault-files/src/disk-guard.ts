// External-change guard for files an app has open (taken from TalkWeaver `outline-disk-guard.ts`,
// generic over the kind of file). A file can change on disk while it is open: another machine on a
// shared cloud folder, a sync client, a text editor, an agent. The app must notice, offer a choice, and
// never write over the newer file (or re-create a removed one) without being told to.
//
// Per open file (keyed by its real path) the guard keeps the BASELINE: the sha256 of the text the app
// holds (loaded or last saved), or ABSENT once the person accepted that the file is gone. The file
// differs from the app exactly when its version is not the baseline:
//   - `changed`  the file holds other text;
//   - `removed`  the file is gone (the app's own moves call `forget` first);
//   - `partial`  an app save failed after truncating the file (`failedHalfway`): never offered for Reload.
// Only the app's own saves move the baseline (`written`, under the file's lock, so the watcher event a
// save causes finds the file equal to the baseline).
//
// Ways in: `track` when an editor loads the file, `release` when it closes; the watcher and window
// focus call `check`; a writer asks `conflict` before every whole-text write, under the lock;
// `accept(hash)` when the person chose (Keep mine, Reload, Save again) having seen version `hash`.

import { createHash } from 'node:crypto'
import { sep } from 'node:path'

export type DiskChangeKind = 'changed' | 'removed' | 'partial'

export interface DiskChange {
  /** The path as the owner that has the file open knows it. */
  path: string
  kind: DiskChangeKind
  /** sha256 of the disk text (changed), `removed`, or `partial:<temp>`. */
  hash: string
  /** The file's modification time (ms), or the time of the event. */
  changedAt: number
  /** partial: the temp file that holds the save's full text. */
  tempPath?: string
}

export type DiskAccept = { ok: true } | { ok: false; change: DiskChange | null; error?: string }

export interface DiskGuardDeps {
  /** The file's real path: the guard's key. */
  canonical(path: string): string
  /** The file's text, or null when it does not exist (ENOENT). Other errors throw. */
  readText(realPath: string): Promise<string | null>
  /** The file's modification time (ms), or null when it does not exist. */
  mtime(realPath: string): Promise<number | null>
  /** Runs `work` holding the file's write lock (guarded-write.ts withFileLock). */
  withLock<T>(path: string, work: () => Promise<T>): Promise<T>
  /** Starts watching `realPath`'s folder; may throw (cannot be watched). Optional: absent = no watcher. */
  watch?(realPath: string, onChange: () => void, onError: () => void): void
  unwatch?(realPath: string): void
  /** Tells `owner` that its file (`path`, its own alias) differs from the disk (change) or no longer does (null). */
  notify(owner: string, path: string, change: DiskChange | null): void
}

export interface DiskGuard {
  track(owner: string, path: string, text: string): void
  release(owner: string): void
  forget(path: string): void
  openUnder(path: string): string[]
  tracks(realPath: string): boolean
  owns(owner: string, path: string): boolean
  watching(realPath: string): boolean
  pendingFor(owner: string): DiskChange | null
  conflict(realPath: string, diskText: string | null, incoming: string): Promise<DiskChange | null>
  written(realPath: string, text: string): void
  failedHalfway(realPath: string, tempPath: string): DiskChange | null
  check(path: string): Promise<DiskChange | null>
  diskVersion(path: string): Promise<{ text: string; hash: string } | null>
  accept(path: string, hash: string, opts?: { keepPending?: boolean }): Promise<DiskAccept>
  pending(path: string): DiskChange | null
  dispose(): void
}

export const hashText = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
/** The version of a missing file. */
export const ABSENT = 'removed'
const partialToken = (tempPath: string): string => `partial:${tempPath}`

interface Entry {
  baseline: string
  owners: Map<string, string>
  reported: DiskChange | null
  awaitingSave: boolean
  partial: { tempPath: string; at: number } | null
  watching: boolean
}

export function createDiskGuard(deps: DiskGuardDeps): DiskGuard {
  const entries = new Map<string, Entry>()
  const firstPath = (entry: Entry, fallback: string): string => entry.owners.values().next().value ?? fallback

  const report = (entry: Entry, change: DiskChange | null): void => {
    if (change === null && entry.awaitingSave) return
    if (change === null ? entry.reported === null : entry.reported?.hash === change.hash) return
    if (change) entry.awaitingSave = false
    entry.reported = change
    for (const [owner, ownerPath] of entry.owners) {
      try { deps.notify(owner, ownerPath, change && { ...change, path: ownerPath }) } catch { /* a closed owner */ }
    }
  }

  const differenceFor = async (realPath: string, entry: Entry, token: string): Promise<DiskChange | null> => {
    const path = firstPath(entry, realPath)
    if (entry.partial) return { path, kind: 'partial', hash: partialToken(entry.partial.tempPath), changedAt: entry.partial.at, tempPath: entry.partial.tempPath }
    if (token === entry.baseline) return null
    if (token === ABSENT) return { path, kind: 'removed', hash: ABSENT, changedAt: Date.now() }
    let changedAt = Date.now()
    try { changedAt = (await deps.mtime(realPath)) ?? changedAt } catch { /* keep now */ }
    return { path, kind: 'changed', hash: token, changedAt }
  }

  const versionOf = (text: string | null): string => text === null ? ABSENT : hashText(text)

  const drop = (realPath: string, entry: Entry): void => {
    if (entry.watching) { entry.watching = false; try { deps.unwatch?.(realPath) } catch { /* already gone */ } }
    if (entries.get(realPath) === entry) entries.delete(realPath)
  }

  const isUnder = (realPath: string, root: string): boolean =>
    realPath === root || realPath.startsWith(root.endsWith(sep) ? root : root + sep)

  const releaseFrom = (owner: string, except?: string): void => {
    for (const [realPath, entry] of [...entries]) {
      if (realPath === except || !entry.owners.delete(owner)) continue
      if (entry.owners.size === 0) drop(realPath, entry)
    }
  }

  const recheck = async (realPath: string): Promise<DiskChange | null> => {
    const entry = entries.get(realPath)
    if (!entry) return null
    let text: string | null
    try { text = await deps.readText(realPath) } catch { return entry.reported }
    const change = await differenceFor(realPath, entry, versionOf(text))
    report(entry, change)
    return change
  }

  const startWatching = (realPath: string, entry: Entry): void => {
    if (!deps.watch) return
    try {
      deps.watch(
        realPath,
        () => { void deps.withLock(realPath, () => recheck(realPath)).catch(() => undefined) },
        () => { entry.watching = false },
      )
      entry.watching = true
    } catch {
      entry.watching = false
    }
  }

  return {
    track(owner, path, text) {
      const realPath = deps.canonical(path)
      releaseFrom(owner, realPath)
      let entry = entries.get(realPath)
      if (!entry) {
        entry = { baseline: '', owners: new Map(), reported: null, awaitingSave: false, partial: null, watching: false }
        entries.set(realPath, entry)
      }
      entry.baseline = hashText(text)
      entry.partial = null
      entry.awaitingSave = false
      entry.owners.set(owner, path)
      report(entry, null)
      if (!entry.watching) startWatching(realPath, entry)
    },
    release(owner) { releaseFrom(owner) },
    forget(path) {
      const root = deps.canonical(path)
      for (const [realPath, entry] of [...entries]) {
        if (!isUnder(realPath, root)) continue
        entry.awaitingSave = false
        report(entry, null)
        drop(realPath, entry)
      }
    },
    openUnder(path) {
      const root = deps.canonical(path)
      return [...entries.keys()].filter((realPath) => isUnder(realPath, root))
    },
    tracks: (realPath) => entries.has(realPath),
    owns(owner, path) {
      const entry = entries.get(deps.canonical(path))
      return !!entry && entry.owners.has(owner)
    },
    watching: (realPath) => entries.get(realPath)?.watching ?? false,
    pending(path) {
      const entry = entries.get(deps.canonical(path))
      return entry?.reported ? { ...entry.reported, path } : null
    },
    pendingFor(owner) {
      for (const entry of entries.values()) {
        const ownerPath = entry.owners.get(owner)
        if (ownerPath !== undefined && entry.reported) return { ...entry.reported, path: ownerPath }
      }
      return null
    },
    async conflict(realPath, diskText, incoming) {
      const entry = entries.get(realPath)
      if (!entry) return null
      const token = versionOf(diskText)
      if (!entry.partial && diskText !== null && token === hashText(incoming)) {
        entry.baseline = token
        report(entry, null)
        return null
      }
      const change = await differenceFor(realPath, entry, token)
      report(entry, change)
      return change
    },
    written(realPath, text) {
      const entry = entries.get(realPath)
      if (!entry) return
      entry.baseline = hashText(text)
      entry.partial = null
      entry.awaitingSave = false
      report(entry, null)
    },
    failedHalfway(realPath, tempPath) {
      const entry = entries.get(realPath)
      if (!entry) return null
      entry.partial = { tempPath, at: Date.now() }
      const change: DiskChange = { path: firstPath(entry, realPath), kind: 'partial', hash: partialToken(tempPath), changedAt: entry.partial.at, tempPath }
      report(entry, change)
      return change
    },
    check(path) {
      const realPath = deps.canonical(path)
      if (!entries.has(realPath)) return Promise.resolve(null)
      return deps.withLock(realPath, () => recheck(realPath))
    },
    diskVersion(path) {
      const realPath = deps.canonical(path)
      return deps.withLock(realPath, async () => {
        const text = await deps.readText(realPath)
        return text === null ? null : { text, hash: hashText(text) }
      })
    },
    accept(path, hash, opts = {}) {
      const realPath = deps.canonical(path)
      return deps.withLock(realPath, async (): Promise<DiskAccept> => {
        const entry = entries.get(realPath)
        if (!entry) return { ok: true }
        let text: string | null
        try { text = await deps.readText(realPath) } catch (error) {
          return { ok: false, change: null, error: error instanceof Error ? error.message : String(error) }
        }
        const token = versionOf(text)
        if (entry.partial) {
          if (hash !== partialToken(entry.partial.tempPath)) return { ok: false, change: { ...(await differenceFor(realPath, entry, token))!, path } }
          entry.partial = null
        } else if (token !== hash) {
          const change = await differenceFor(realPath, entry, token)
          report(entry, change)
          if (change) return { ok: false, change: { ...change, path } }
        }
        entry.baseline = token
        if (opts.keepPending && entry.reported) entry.awaitingSave = true
        else report(entry, null)
        return { ok: true }
      })
    },
    dispose() {
      for (const [realPath, entry] of [...entries]) drop(realPath, entry)
    },
  }
}
