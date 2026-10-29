// Sync-conflict copies (taken from TalkWeaver `conflict-copies.mjs`; generalised from `*-outline.md`
// to any canonical file name, such as `course.md` or `library.json`).
//
// A file is a conflict copy of canonical `S.ext` when it sits in the same folder and is named
//   OneDrive      `S-<Machine>.ext`         (and `<slug>-<Machine>-outline.md` for an outline)
//   Dropbox       `S (<…>conflicted copy<…>).ext`
//   Google Drive  `S (1).ext` / `S(1).ext`  (any 1-2 digit number)
// or when a text file `S.ext` itself holds Git conflict markers at line starts.
//
// A `<Machine>` suffix counts only when (a) it is a known machine name for the vault (slugged as
// OneDrive writes it), or (b) it looks like one: some hyphen-separated token is mac, macbook, imac,
// mini, pc, air, pro or studio, or the suffix is DESKTOP-<x> / LAPTOP-<x>. So `S-EN.md`, `S-v2.md`,
// `S-notes.md` are the author's own files, never copies.
//
// The scanner reads one folder, classifies, and moves byte-identical copies to the OS Trash through the
// injected `trashItem` (never unlink). Differing copies and Git markers are only reported.

import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

const OUTLINE_SUFFIX = '-outline.md'
const MACHINE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const MACHINE_TOKENS = new Set(['mac', 'macbook', 'imac', 'mini', 'pc', 'air', 'pro', 'studio'])
const WINDOWS_DEFAULT = /^(desktop|laptop)-[A-Za-z0-9_]+/i
/** Extensions whose text is checked for Git conflict markers. */
const TEXT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.json', '.yml', '.yaml'])

export type ConflictService = 'onedrive' | 'dropbox' | 'gdrive' | 'git'
export type ConflictState = 'identical' | 'differs' | 'git-markers'
export type ConflictCopy = { name: string; service: ConflictService; source: string | null; state: ConflictState }
export type MachineOptions = { knownMachines?: readonly string[]; loose?: boolean }

/** A computer name as OneDrive puts it in a file name ("Dominik’s MacBook Air" → "Dominiks-MacBook-Air"). */
export function machineSlug(name: unknown): string {
  return String(name ?? '').replace(/\.local$/i, '').replace(/['’]/g, '').trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9_-]/g, '')
}

export function isMachineName(token: unknown, { knownMachines = [], loose = false }: MachineOptions = {}): boolean {
  if (typeof token !== 'string' || !MACHINE.test(token) || /(^|-)outline$/i.test(token)) return false
  if (loose) return true
  const lower = token.toLowerCase()
  if (knownMachines.some((m) => machineSlug(m).toLowerCase() === lower && lower !== '')) return true
  if (WINDOWS_DEFAULT.test(token)) return true
  return token.split('-').some((part) => MACHINE_TOKENS.has(part.toLowerCase()))
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The service that named `name` as a conflict copy of `canonicalName`, or null. */
export function conflictServiceOf(name: unknown, canonicalName: unknown, options: MachineOptions = {}): { service: Exclude<ConflictService, 'git'>; source: string | null } | null {
  if (typeof name !== 'string' || typeof canonicalName !== 'string') return null
  const ext = extname(canonicalName)
  if (!ext || extname(name).toLowerCase() !== ext.toLowerCase()) return null
  if (name === canonicalName || name.toLowerCase() === canonicalName.toLowerCase()) return null
  if (name.includes('/') || name.includes('\\')) return null
  const base = canonicalName.slice(0, -ext.length)
  const stem = name.slice(0, -ext.length)
  if (stem.startsWith(base + '-')) {
    const machine = stem.slice(base.length + 1)
    if (isMachineName(machine, options)) return { service: 'onedrive', source: machine }
  }
  if (canonicalName.endsWith(OUTLINE_SUFFIX) && name.endsWith(OUTLINE_SUFFIX)) {
    const slug = canonicalName.slice(0, -OUTLINE_SUFFIX.length)
    const other = name.slice(0, -OUTLINE_SUFFIX.length)
    if (other.startsWith(slug + '-')) {
      const machine = other.slice(slug.length + 1)
      if (isMachineName(machine, options)) return { service: 'onedrive', source: machine }
    }
  }
  const dropbox = stem.match(new RegExp(`^${escapeRe(base)} \\((.*conflicted copy.*)\\)$`, 'i'))
  if (dropbox) {
    const who = dropbox[1]!.match(/^(.+?)['’]s conflicted copy/i)
    return { service: 'dropbox', source: who ? who[1]!.trim() : null }
  }
  if (new RegExp(`^${escapeRe(base)} ?\\(\\d{1,2}\\)$`).test(stem)) return { service: 'gdrive', source: null }
  return null
}

export function conflictCandidateNames(names: readonly string[] | null | undefined, canonicalName: string, options: MachineOptions = {}): string[] {
  return (names ?? []).filter((n) => conflictServiceOf(n, canonicalName, options) !== null)
}

/** True when the text holds a Git conflict block (`<<<<<<< `, `=======`, `>>>>>>> ` at line starts, in
 *  order), outside fenced code blocks. A lone `=======` (a heading underline) is not one. */
export function hasGitConflictMarkers(text: unknown): boolean {
  if (typeof text !== 'string' || !text.includes('<<<<<<<')) return false
  let stage = 0
  let fence: string | null = null
  for (const line of text.split(/\r?\n/)) {
    const run = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1]
    if (fence) {
      if (run && run[0] === fence[0] && run.length >= fence.length && line.trim() === run) fence = null
      continue
    }
    if (run) { fence = run; continue }
    if (stage === 0 && /^<{7}( |$)/.test(line)) stage = 1
    else if (stage === 1 && /^={7}\s*$/.test(line)) stage = 2
    else if (stage === 2 && /^>{7}( |$)/.test(line)) return true
  }
  return false
}

type Bytes = Uint8Array | string | null | undefined
const toBuffer = (b: Bytes): Buffer | null => (b == null ? null : Buffer.isBuffer(b) ? b : typeof b === 'string' ? Buffer.from(b, 'utf8') : Buffer.from(b))

/** Pure classification of one folder: copies in listing order; a `git-markers` entry (named as the
 *  canonical file) first when the canonical text holds markers. Missing bytes → `differs`. */
export function classifyConflict(
  listing: ReadonlyArray<{ name: string; bytes?: Bytes }> | null | undefined,
  canonical: { name: string; bytes: Bytes },
  options: MachineOptions = {},
): ConflictCopy[] {
  const out: ConflictCopy[] = []
  if (!canonical || typeof canonical.name !== 'string') return out
  const canonicalBytes = toBuffer(canonical.bytes)
  if (canonicalBytes && TEXT_EXTENSIONS.has(extname(canonical.name).toLowerCase()) && hasGitConflictMarkers(canonicalBytes.toString('utf8'))) {
    out.push({ name: canonical.name, service: 'git', source: null, state: 'git-markers' })
  }
  for (const entry of listing ?? []) {
    const match = conflictServiceOf(entry?.name, canonical.name, options)
    if (!match) continue
    const bytes = toBuffer(entry.bytes)
    const identical = Boolean(canonicalBytes && canonicalBytes.length > 0 && bytes && bytes.equals(canonicalBytes))
    out.push({ name: entry.name, service: match.service, source: match.source, state: identical ? 'identical' : 'differs' })
  }
  return out
}

export function sourceLabel(source: string | null | undefined): string | null {
  return typeof source === 'string' && source ? source.replace(/[-_]+/g, ' ').trim() : null
}

export type ConflictScannerDeps = {
  /** Moves the file to the OS Trash (Electron shell.trashItem); never an unlink. */
  trashItem: (path: string) => Promise<void>
  /** paths.ts pathStaysInside: the real path or null. */
  staysInside: (root: string, candidate: string) => string | null
  /** A line for the app's activity view: an identical copy was moved to the Trash. */
  onTrashed?: (scope: string, copy: ConflictCopy) => unknown
  canTouch?: (scope: string) => boolean
  /** Runs `work` holding the canonical file's write lock (guarded-write.ts withFileLock). */
  withLock?: <T>(path: string, work: () => Promise<T>) => Promise<T>
  knownMachines?: (scope: string) => readonly string[] | Promise<readonly string[]>
  rememberMachines?: (scope: string, names: string[]) => unknown
  log?: (message: string) => void
}

export type ConflictScan = { conflicts: number; copies: ConflictCopy[]; trashed: string[] }

export function createConflictScanner(deps: ConflictScannerDeps): { scanFolder(input: { scope: string; folder: string; canonicalName: string; names?: string[] }): Promise<ConflictScan | null> } {
  const canTouch = deps.canTouch ?? (() => true)
  const withLock = deps.withLock ?? (<T>(_path: string, work: () => Promise<T>) => work())
  const log = deps.log ?? (() => {})

  async function bytesOf(path: string): Promise<Buffer | null> {
    try {
      const st = await lstat(path)
      if (!st.isFile()) return null
      return await readFile(path)
    } catch { return null }
  }

  async function trashIdentical(folder: string, canonicalName: string, name: string, options: MachineOptions): Promise<boolean> {
    if (!name || name !== basename(name) || name === '.' || name === '..') return false
    if (name.toLowerCase() === canonicalName.toLowerCase()) return false
    if (!conflictServiceOf(name, canonicalName, options)) return false
    const copyPath = join(folder, name)
    const canonicalPath = join(folder, canonicalName)
    const realCopy = deps.staysInside(folder, copyPath)
    if (!realCopy) return false
    let realCanonical: string
    try { realCanonical = await realpath(canonicalPath) } catch { return false }
    if (realCopy === realCanonical) return false
    try {
      const [a, b] = await Promise.all([lstat(copyPath), lstat(canonicalPath)])
      if (!a.isFile()) return false
      if (a.dev === b.dev && a.ino === b.ino) return false
    } catch { return false }
    return withLock(realCanonical, async () => {
      const [copyBytes, canonicalBytes] = await Promise.all([bytesOf(copyPath), bytesOf(canonicalPath)])
      if (!copyBytes || !canonicalBytes || canonicalBytes.length === 0 || !copyBytes.equals(canonicalBytes)) return false
      await deps.trashItem(copyPath)
      return true
    })
  }

  async function scanFolder({ scope, folder, canonicalName, names }: { scope: string; folder: string; canonicalName: string; names?: string[] }): Promise<ConflictScan | null> {
    if (!canTouch(scope)) return null
    const canonicalBytes = await bytesOf(join(folder, canonicalName))
    if (!canonicalBytes) return null
    let listing = names
    if (!Array.isArray(listing)) {
      try { listing = (await readdir(folder, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name) } catch { return null }
    }
    let machines: readonly string[] = []
    try { machines = (await deps.knownMachines?.(scope)) ?? [] } catch { machines = [] }
    const options = { knownMachines: machines }
    const candidates = conflictCandidateNames(listing, canonicalName, options)
    const entries: { name: string; bytes: Buffer | null }[] = []
    for (const name of candidates) entries.push({ name, bytes: await bytesOf(join(folder, name)) })
    const copies = classifyConflict(entries, { name: canonicalName, bytes: canonicalBytes }, options)
    const seen = copies.filter((c) => c.service === 'onedrive' && c.source).map((c) => c.source!)
    if (seen.length) { try { await deps.rememberMachines?.(scope, seen) } catch { /* best effort */ } }
    const trashed: string[] = []
    const remaining: ConflictCopy[] = []
    for (const copy of copies) {
      if (copy.state !== 'identical') { remaining.push(copy); continue }
      if (!canTouch(scope)) { remaining.push({ ...copy, state: 'differs' }); continue }
      let moved = false
      try { moved = await trashIdentical(folder, canonicalName, copy.name, options) } catch (error) {
        log(`[conflict-copies] trash failed for ${copy.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (!moved) {
        const still = await lstat(join(folder, copy.name)).then(() => true, () => false)
        if (still) remaining.push({ ...copy, state: 'differs' })
        continue
      }
      trashed.push(copy.name)
      try { await deps.onTrashed?.(scope, copy) } catch (error) {
        log(`[conflict-copies] activity line not written: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { conflicts: remaining.length, copies: remaining, trashed }
  }

  return { scanFolder }
}
