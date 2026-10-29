// Path rules for a folder of content files ("vault"): every path that names a file inside the vault is
// vault-relative, '/'-separated, never absolute, never `..`, and no part of it on disk is a link.
//
// `pathStaysInside` is TalkWeaver's containment check (talk-weaver src/main/path-containment.ts, copied
// unchanged): lexical, then by real path through the nearest part that exists.

import { lstatSync, realpathSync } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

function lexists(path: string): boolean {
  try { lstatSync(path); return true } catch { return false }
}

function within(parent: string, child: string, allowSame: boolean): boolean {
  if (parent === child) return allowSame
  const rel = relative(parent, child)
  return rel !== '' && !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}

/**
 * `candidate` (may not exist yet) stays inside `root`, lexically and once symlinks are resolved: the
 * nearest part of the path that exists must resolve inside the root's real path. Returns the
 * candidate's resolved real path (for a path that does not exist yet: its nearest existing ancestor's
 * real path plus the rest), or null when it would leave the root. `allowRoot` accepts the root itself.
 */
export function pathStaysInside(root: string, candidate: string, allowRoot = false): string | null {
  if (typeof root !== 'string' || typeof candidate !== 'string' || !root || !candidate) return null
  if (root.includes('\0') || candidate.includes('\0')) return null
  const r = resolve(root)
  const t = resolve(r, candidate)
  if (!within(r, t, allowRoot)) return null
  let base = r
  while (!lexists(base)) {
    const parent = dirname(base)
    if (parent === base) return null
    base = parent
  }
  let realRoot: string
  try { realRoot = join(realpathSync(base), relative(base, r)) } catch { return null }
  let probe = t
  while (!lexists(probe)) {
    const parent = dirname(probe)
    if (parent === probe) return null
    probe = parent
  }
  if (probe !== t && within(probe, r, true)) return join(realRoot, relative(r, t))
  let real: string
  try { real = realpathSync(probe) } catch { return null }
  if (!within(realRoot, real, allowRoot || probe !== t)) return null
  return probe === t ? real : join(real, relative(probe, t))
}

/** True for a string that reads as an absolute path or an address on any platform: `/…`, `~/…`,
 *  `C:\…`, `\\server`, `scheme://…`. */
export function looksAbsolute(value: string): boolean {
  const v = value.trim()
  return v.startsWith('/') || v.startsWith('~') || v.startsWith('\\') || /^[a-zA-Z]:[\\/]/.test(v) || /^[a-z][a-z0-9+.-]*:\/\//i.test(v)
}

/** A vault-relative path as files store it: '/'-separated, no empty, `.` or `..` part, no backslash,
 *  no NUL, not absolute, no scheme. */
export function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 4096) return false
  if (value.includes('\0') || value.includes('\\')) return false
  if (value.startsWith('/') || value.startsWith('~') || /^[a-zA-Z]:/.test(value) || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return false
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

export type InsideRefusal = 'outside' | 'is-a-link' | 'not-a-folder'

/** Why a vault-relative path cannot be used. */
export class VaultPathRefused extends Error {
  override readonly name = 'VaultPathRefused'
  constructor(readonly code: InsideRefusal, readonly path: string) {
    super({
      outside: `${path} is not a path inside this folder.`,
      'is-a-link': `${path} goes through a link; links are not followed inside this folder.`,
      'not-a-folder': `${path} goes through something that is not a folder.`,
    }[code])
  }
}

/**
 * The absolute path of vault-relative `rel` under the vault's real root, after checking that no part
 * of it that exists is a link (the last part included) and every part above the last is a folder.
 * Parts that do not exist yet are fine. Throws VaultPathRefused.
 */
export async function resolveInside(realRoot: string, rel: string): Promise<string> {
  if (!isSafeRelativePath(rel)) throw new VaultPathRefused('outside', String(rel))
  const parts = rel.split('/')
  let here = realRoot
  for (let i = 0; i < parts.length; i += 1) {
    here = join(here, parts[i]!)
    let info
    try { info = await lstat(here) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return join(realRoot, ...parts)
      if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') throw new VaultPathRefused('not-a-folder', rel)
      throw error
    }
    if (info.isSymbolicLink()) throw new VaultPathRefused('is-a-link', rel)
    if (i < parts.length - 1 && !info.isDirectory()) throw new VaultPathRefused('not-a-folder', rel)
  }
  return here
}

/** The vault root's real path; refuses a root that is itself a link or not a folder. */
export async function realVaultRoot(root: string): Promise<string> {
  const abs = resolve(root)
  const info = await lstat(abs)
  if (info.isSymbolicLink()) throw new VaultPathRefused('is-a-link', abs)
  if (!info.isDirectory()) throw new VaultPathRefused('not-a-folder', abs)
  return realpath(abs)
}

/** `rel` with '/' separators from a native relative path. */
export const toVaultRelative = (nativeRel: string): string => nativeRel.split(sep).join('/')
