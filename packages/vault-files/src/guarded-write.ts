// Guarded writes into a vault (a folder of content files that a cloud client, an editor, an agent or
// a second machine may also write). Taken from WriteFlex `guarded-document-write.ts` (create) and
// TalkWeaver `talk-writer.ts` (in-place rewrite), joined into one module with one lock.
//
// Create (a new file, never over an existing one):
//   - the bytes go to a temp file beside the target, opened O_CREAT|O_EXCL|O_NOFOLLOW, so a link at
//     that name is refused; where the opened file really landed is compared with the folder judged a
//     moment before (a folder swapped for a link is seen and refused before a byte is written);
//   - the file takes its name by a hard link, which fails when the name is taken; a disk without hard
//     links falls back to "name still free, then rename".
// Rewrite (an existing file, in place):
//   - under the file's lock the new bytes are staged in a temp file beside it and fsynced;
//   - the target is opened through one no-follow handle; its bytes are read through that handle and
//     must hash to `expect` (the sha256 of the bytes the new text was worked out from), else nothing
//     is written (`changed`);
//   - the same handle is truncated, written and fsynced: the inode never changes, so a cloud client
//     keeps the file's identity, hard links stay one file, and mode bits, ACLs and extended attributes
//     are kept. A read-only target is refused untouched;
//   - a failure after truncation keeps the temp file (the only whole copy) and the error names it.
// Every path is vault-relative; no part of it may be a link (paths.ts resolveInside); the vault root
// is never created.
//
// What Node cannot close: there is no "open relative to a folder handle", so between the last check
// and the link (create) or the truncate (rewrite) another program could still replace a part of the
// path or rewrite the file. The rewrite re-checks the path names the same inode afterwards and
// reports a write that may have landed elsewhere (`landed`), never as done.

import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { access, link, lstat, mkdir, open, realpath, rename, stat, unlink, type FileHandle } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { realVaultRoot, resolveInside, VaultPathRefused } from './paths.ts'

export type GuardedWriteCode =
  | 'outside' | 'is-a-link' | 'exists' | 'not-a-file' | 'no-folder' | 'no-vault' | 'swapped' | 'changed' | 'read-only'

/** Why a guarded write wrote nothing. `code` is stable; each app says it in its own words. */
export class GuardedWriteRefused extends Error {
  override readonly name = 'GuardedWriteRefused'
  constructor(readonly code: GuardedWriteCode, readonly path: string) {
    super({
      outside: `${path} is not a path inside this folder.`,
      'is-a-link': `${path} is a link or goes through one, so it was not written.`,
      exists: `${path} already exists.`,
      'not-a-file': `${path} is not an existing file.`,
      'no-folder': `The folder for ${path} does not exist.`,
      'no-vault': `The folder ${path} should be written into is not there.`,
      swapped: `${path} was not written: its folder changed while it was being saved.`,
      changed: `${path} changed since it was read, so nothing was written.`,
      'read-only': `${path} is read-only, so nothing was written.`,
    }[code])
  }
}

/** A rewrite that failed after the file was truncated: `partialTemp` holds the full new bytes. */
export type PartialWriteError = Error & { partialTemp: string }
/** A rewrite whose bytes went in but the path no longer names the file written. */
export type LandedWriteError = Error & { landed: true }

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code
/** A disk that has no hard links answers a link with one of these. */
export const NO_HARD_LINKS = new Set(['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV'])
/** Temp files this module makes end with this (watchers and scanners ignore them). */
export const TEMP_SUFFIX = '.vf-write'

export const sha256Hex = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes).digest('hex')

const toBytes = (content: string | Uint8Array): Uint8Array => typeof content === 'string' ? Buffer.from(content, 'utf8') : content

// One promise chain per key (the file's real path): one writer at a time per file.
const locks = new Map<string, Promise<void>>()
/** Runs `work` holding the lock for `key` (a file's real path). Every create and rewrite of that file
 *  takes it; a reader that must not see a half-written file can take it too. */
export function withFileLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const run = (locks.get(key) ?? Promise.resolve()).then(work)
  const tail = run.then(() => undefined, () => undefined)
  locks.set(key, tail)
  void tail.then(() => { if (locks.get(key) === tail) locks.delete(key) })
  return run
}

// Writes named by the same root and relative path queue in call order before their real path is
// resolved (an async step): two levels, always taken in this order (call-order key, then real path).
const callOrder = new Map<string, Promise<void>>()
function inCallOrder<T>(root: string, rel: string, work: () => Promise<T>): Promise<T> {
  const key = `${resolve(root)}\0${rel}`
  const run = (callOrder.get(key) ?? Promise.resolve()).then(work)
  const tail = run.then(() => undefined, () => undefined)
  callOrder.set(key, tail)
  void tail.then(() => { if (callOrder.get(key) === tail) callOrder.delete(key) })
  return run
}

/** Test seams; never set by an app. */
export type WriteSeams = {
  /** After every check, just before the temp file is made (create) or the target opened (rewrite). */
  betweenCheckAndWrite?: (rel: string) => Promise<void>
  /** Rewrite: after the target is truncated, before the bytes go in (a throw = failed halfway). */
  afterTruncate?: (rel: string) => Promise<void>
  /** Rewrite: after the bytes are in, before the last "same file" check. */
  afterWrite?: (rel: string) => Promise<void>
}

async function vaultRoot(root: string): Promise<string> {
  try { return await realVaultRoot(root) } catch (error) {
    if (error instanceof VaultPathRefused) throw new GuardedWriteRefused('is-a-link', root)
    if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') throw new GuardedWriteRefused('no-vault', root)
    throw error
  }
}

async function inside(realRoot: string, rel: string): Promise<string> {
  try { return await resolveInside(realRoot, rel) } catch (error) {
    if (error instanceof VaultPathRefused) throw new GuardedWriteRefused(error.code === 'outside' ? 'outside' : error.code === 'is-a-link' ? 'is-a-link' : 'no-folder', rel)
    throw error
  }
}

const parentRel = (rel: string): string => rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''

/** The real folder holding `abs`, which must be `expected` (its folder under the vault's real root). */
async function realParent(abs: string, expected: string, rel: string): Promise<string> {
  let real: string
  try { real = await realpath(dirname(abs)) } catch { throw new GuardedWriteRefused('no-folder', rel) }
  if (real !== expected) throw new GuardedWriteRefused('swapped', rel)
  return real
}

async function syncFolder(folder: string): Promise<void> {
  try {
    const dir = await open(folder, 'r')
    try { await dir.sync() } finally { await dir.close() }
  } catch { /* not every filesystem syncs a folder */ }
}

/**
 * Makes vault-relative folder `rel` and any missing folders above it, never the vault root itself and
 * never through a link. An existing folder is fine.
 */
export async function makeFolder(root: string, rel: string): Promise<string> {
  const realRoot = await vaultRoot(root)
  const abs = await inside(realRoot, rel)
  let here = realRoot
  for (const part of rel.split('/')) {
    here = join(here, part)
    try { await mkdir(here, { mode: 0o755 }) } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
    }
    const info = await lstat(here)
    if (info.isSymbolicLink()) throw new GuardedWriteRefused('is-a-link', rel)
    if (!info.isDirectory()) throw new GuardedWriteRefused('no-folder', rel)
  }
  return abs
}

export type CreateOptions = {
  /** Make missing folders above the file (inside the vault). Default false: the folder must exist. */
  makeFolders?: boolean
  /** Mode of the new file (default 0o644). */
  mode?: number
  seams?: WriteSeams
}

/**
 * Writes `content` as a NEW file at vault-relative `rel`. Refuses (`exists`) when the name is taken,
 * also when it is taken between the check and the commit. Returns the file's absolute real path and
 * the sha256 of the bytes written.
 */
export function createFile(root: string, rel: string, content: string | Uint8Array, options: CreateOptions = {}): Promise<{ path: string; sha256: string }> {
  return inCallOrder(root, rel, () => createFileNow(root, rel, content, options))
}

async function createFileNow(root: string, rel: string, content: string | Uint8Array, options: CreateOptions): Promise<{ path: string; sha256: string }> {
  const realRoot = await vaultRoot(root)
  const abs = await inside(realRoot, rel)
  return withFileLock(abs, async () => {
    const folderRel = parentRel(rel)
    if (options.makeFolders && folderRel) await makeFolder(realRoot, folderRel)
    const expected = folderRel ? join(realRoot, ...folderRel.split('/')) : realRoot
    const existing = await lstat(abs).catch(() => null)
    if (existing?.isSymbolicLink()) throw new GuardedWriteRefused('is-a-link', rel)
    if (existing) throw new GuardedWriteRefused('exists', rel)
    const folder = await realParent(abs, expected, rel)
    await options.seams?.betweenCheckAndWrite?.(rel)
    const bytes = toBytes(content)
    const staged = join(folder, `.${basename(abs)}.${randomBytes(6).toString('hex')}${TEMP_SUFFIX}`)
    const handle = await open(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, options.mode ?? 0o644)
    let realStaged: string | null = null
    try {
      // Where did the file just opened really land? Trust nothing but the open handle.
      const opened = await handle.stat()
      const landed = await realpath(staged)
      const there = await lstat(landed)
      if (there.ino !== opened.ino || there.dev !== opened.dev) throw new GuardedWriteRefused('swapped', rel)
      realStaged = landed
      if (dirname(landed) !== folder) throw new GuardedWriteRefused('swapped', rel)
      let offset = 0
      while (offset < bytes.length) {
        const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset)
        offset += bytesWritten
      }
      await handle.sync().catch(() => {})
    } catch (error) {
      await handle.close().catch(() => {})
      await unlink(realStaged ?? staged).catch(() => {})
      throw error
    }
    await handle.close()
    const final = join(folder, basename(abs))
    try {
      try {
        await link(realStaged, final)
        await unlink(realStaged)
      } catch (error) {
        if (!NO_HARD_LINKS.has(errorCode(error) ?? '')) throw error
        // No hard links on this disk (the link wrote nothing): the name is checked free, then renamed.
        if (await lstat(final).catch(() => null)) throw new GuardedWriteRefused('exists', rel)
        await rename(realStaged, final)
      }
    } catch (error) {
      await unlink(realStaged).catch(() => {})
      throw errorCode(error) === 'EEXIST' ? new GuardedWriteRefused('exists', rel) : error
    }
    await syncFolder(folder)
    return { path: final, sha256: sha256Hex(bytes) }
  })
}

export type RewriteOptions = {
  /** sha256 (hex) of the bytes the new content was worked out from: the file must still hold them. */
  expect: string
  seams?: WriteSeams
}

/**
 * Rewrites the EXISTING file at vault-relative `rel` in place with `content`, only while its bytes
 * still hash to `options.expect`. A missing file is never re-created (`not-a-file`). Returns
 * `changed: false` (nothing written) when the file already holds exactly `content`.
 * Throws GuardedWriteRefused (nothing written), a PartialWriteError (failed after truncating; the
 * temp file kept) or a LandedWriteError (written, but the path now names another file).
 */
export function rewriteFile(root: string, rel: string, content: string | Uint8Array, options: RewriteOptions): Promise<{ path: string; sha256: string; changed: boolean }> {
  if (typeof options?.expect !== 'string' || !/^[0-9a-f]{64}$/.test(options.expect)) return Promise.reject(new TypeError('rewriteFile needs the sha256 the content was worked out from.'))
  return inCallOrder(root, rel, () => rewriteFileNow(root, rel, content, options))
}

async function rewriteFileNow(root: string, rel: string, content: string | Uint8Array, options: RewriteOptions): Promise<{ path: string; sha256: string; changed: boolean }> {
  const realRoot = await vaultRoot(root)
  const abs = await inside(realRoot, rel)
  return withFileLock(abs, async () => {
    const folderRel = parentRel(rel)
    const expected = folderRel ? join(realRoot, ...folderRel.split('/')) : realRoot
    const standing = await lstat(abs).catch(() => null)
    if (standing?.isSymbolicLink()) throw new GuardedWriteRefused('is-a-link', rel)
    if (!standing?.isFile()) throw new GuardedWriteRefused('not-a-file', rel)
    try { await access(abs, constants.W_OK) } catch { throw new GuardedWriteRefused('read-only', rel) }
    const folder = await realParent(abs, expected, rel)
    const bytes = toBytes(content)
    const newHash = sha256Hex(bytes)
    const temp = join(folder, `.${basename(abs)}.${randomBytes(6).toString('hex')}${TEMP_SUFFIX}`)
    let staged: FileHandle | null = null
    try {
      staged = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      await staged.writeFile(bytes)
      await staged.sync()
      await staged.close()
      staged = null
    } catch (error) {
      if (staged) await staged.close().catch(() => undefined)
      await unlink(temp).catch(() => undefined)
      throw error
    }
    const dropTemp = (): Promise<void> => unlink(temp).catch(() => undefined)
    await options.seams?.betweenCheckAndWrite?.(rel)
    let target: FileHandle
    try {
      target = await open(abs, constants.O_RDWR | constants.O_NOFOLLOW)
    } catch (error) {
      await dropTemp()
      const code = errorCode(error)
      if (code === 'ELOOP') throw new GuardedWriteRefused('is-a-link', rel)
      if (code === 'ENOENT') throw new GuardedWriteRefused('not-a-file', rel)
      if (code === 'EACCES' || code === 'EPERM') throw new GuardedWriteRefused('read-only', rel)
      throw error
    }
    let truncated = false
    let opened = ''
    try {
      const st = await target.stat()
      opened = `${st.dev}:${st.ino}`
      if (!st.isFile() || st.ino !== standing.ino || st.dev !== standing.dev) throw new GuardedWriteRefused('changed', rel)
      const current = sha256Hex(await target.readFile())
      if (current !== options.expect) throw new GuardedWriteRefused('changed', rel)
      if (current === newHash) {
        await target.close()
        await dropTemp()
        return { path: abs, sha256: newHash, changed: false }
      }
      await target.truncate(0)
      truncated = true
      await options.seams?.afterTruncate?.(rel)
      let offset = 0
      while (offset < bytes.length) {
        const { bytesWritten } = await target.write(bytes, offset, bytes.length - offset, offset)
        offset += bytesWritten
      }
      await target.sync()
      await target.close()
    } catch (error) {
      await target.close().catch(() => undefined)
      if (!truncated) {
        await dropTemp()
        throw error
      }
      const message = error instanceof Error ? error.message : String(error)
      const partial = new Error(`${message}: ${rel} may be incomplete; its full new text is kept in ${temp} (rename that file over it by hand to recover it).`) as PartialWriteError
      partial.partialTemp = temp
      throw partial
    }
    await dropTemp()
    await options.seams?.afterWrite?.(rel)
    let now = ''
    try { const st = await stat(abs); now = `${st.dev}:${st.ino}` } catch { /* gone */ }
    if (now !== opened) throw Object.assign(new Error(`${rel} was replaced while it was being written (by another program). This change may not be in the file; check it and save again.`), { landed: true as const })
    return { path: abs, sha256: newHash, changed: true }
  })
}

/**
 * Reads vault-relative `rel` through one no-follow handle: its bytes and sha256, or null when there
 * is no file. A link anywhere on the path is refused (GuardedWriteRefused 'is-a-link'); a folder or
 * other non-file at the name reads as null.
 */
export async function readFileGuarded(root: string, rel: string, maxBytes = Number.POSITIVE_INFINITY): Promise<{ bytes: Uint8Array; sha256: string; path: string } | null> {
  const realRoot = await vaultRoot(root)
  const abs = await inside(realRoot, rel)
  let handle: FileHandle
  try { handle = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) } catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    if (code === 'ELOOP') throw new GuardedWriteRefused('is-a-link', rel)
    throw error
  }
  try {
    const st = await handle.stat()
    if (!st.isFile()) return null
    if (st.size > maxBytes) throw new RangeError(`${rel} is larger than ${maxBytes} bytes.`)
    const bytes = new Uint8Array(await handle.readFile())
    return { bytes, sha256: sha256Hex(bytes), path: abs }
  } finally {
    await handle.close()
  }
}
