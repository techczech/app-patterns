// The marker file of a vault (taken from TalkWeaver `vault-file.ts`, parameterised by the app's folder
// and file name): `<root>/.<app>/<name>.json`, the part of a vault's settings everyone who opens the
// folder shares. It travels with the folder, so it is what two machines agree on: the vault's `id`.
//
// Rules:
//   - Read never writes. A file larger than the cap is not read.
//   - `schema` absent or the app's schema = ours to write; anything else is a newer build's: the app
//     opens the vault read-only.
//   - Unknown keys (a newer build's, a colleague's) are kept on write, in their place.
//   - No string value written may look like an absolute path or an address.
//   - The marker folder and file must not be links; the write goes through guarded-write.ts (create
//     when absent, in-place rewrite checked against the bytes read).

import { createFile, GuardedWriteRefused, readFileGuarded, rewriteFile, sha256Hex } from './guarded-write.ts'
import { looksAbsolute } from './paths.ts'

export const VAULT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
export const VAULT_FILE_MAX_BYTES = 1024 * 1024

export type VaultFile = { id: string; schema?: unknown; [key: string]: unknown }

export type VaultFileRead =
  | { state: 'none' }
  | { state: 'ok'; file: VaultFile; sha256: string; ours: boolean }
  | { state: 'invalid'; reason: 'unreadable' | 'not-json' | 'no-id' | 'bad-id' | 'is-a-link' | 'too-large' }

export class VaultFileError extends Error {
  override readonly name = 'VaultFileError'
  constructor(readonly reason: 'absolute-path' | 'newer-schema' | 'bad-id' | 'changed' | 'exists' | 'unavailable', message: string) {
    super(message)
  }
}

/** Parse the text of a marker file: a JSON object with a string id matching the pattern. */
export function parseVaultFile(text: string): { state: 'ok'; file: VaultFile } | { state: 'invalid'; reason: 'not-json' | 'no-id' | 'bad-id' } {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return { state: 'invalid', reason: 'not-json' } }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { state: 'invalid', reason: 'not-json' }
  const obj = raw as Record<string, unknown>
  if (typeof obj.id !== 'string' || !obj.id) return { state: 'invalid', reason: 'no-id' }
  if (!VAULT_ID_PATTERN.test(obj.id)) return { state: 'invalid', reason: 'bad-id' }
  return { state: 'ok', file: Object.assign(Object.create(null), obj) as VaultFile }
}

/** Every string value in `value` (nested included) that looks like an absolute path or an address. */
export function absoluteValues(value: unknown, at = ''): string[] {
  if (typeof value === 'string') return looksAbsolute(value) ? [at || '(value)'] : []
  if (Array.isArray(value)) return value.flatMap((v, i) => absoluteValues(v, `${at}[${i}]`))
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => absoluteValues(v, at ? `${at}.${k}` : k))
  return []
}

export type VaultFileSpec = {
  /** The app's folder in the vault, e.g. `.learnweaver`. */
  dir: string
  /** The file's name, e.g. `library.json`. */
  name: string
  /** The schema this build writes. */
  schema: number
}

export interface VaultFileStore {
  readonly rel: string
  read(root: string): Promise<VaultFileRead>
  /**
   * Writes a new marker file (refuses when one exists). `fields` must hold `id`; `schema` is set.
   */
  create(root: string, fields: Record<string, unknown> & { id: string }): Promise<VaultFile>
  /**
   * Applies `patch` to the file read as `read` (unknown keys kept in place; a key set to undefined is
   * removed) and rewrites it in place, only while it still holds the bytes read.
   */
  update(root: string, read: Extract<VaultFileRead, { state: 'ok' }>, patch: Record<string, unknown>): Promise<VaultFile>
}

export const vaultFileBytes = (file: VaultFile): string => JSON.stringify(file, null, 2) + '\n'

export function createVaultFileStore(spec: VaultFileSpec): VaultFileStore {
  if (!/^\.[A-Za-z0-9_-]+$/.test(spec.dir) || !/^[A-Za-z0-9_-]+\.json$/.test(spec.name)) throw new TypeError('A vault file lives in .<app>/<name>.json.')
  const rel = `${spec.dir}/${spec.name}`
  const ours = (file: VaultFile): boolean => file.schema === undefined || file.schema === spec.schema
  const checkValues = (file: VaultFile): void => {
    const bad = absoluteValues(file)
    if (bad.length) throw new VaultFileError('absolute-path', `The vault file cannot hold a folder path or an address (${bad.join(', ')}).`)
    if (!VAULT_ID_PATTERN.test(file.id)) throw new VaultFileError('bad-id', 'The vault id must be 1-64 letters, digits, - or _.')
  }
  const refusal = (error: unknown): never => {
    if (error instanceof GuardedWriteRefused) {
      if (error.code === 'exists') throw new VaultFileError('exists', 'This folder already has a vault file.')
      if (error.code === 'changed' || error.code === 'not-a-file') throw new VaultFileError('changed', 'The vault file changed since it was read. Nothing was written.')
      if (error.code === 'no-vault') throw new VaultFileError('unavailable', 'The folder is not there.')
    }
    throw error
  }
  return {
    rel,
    async read(root) {
      let got
      try { got = await readFileGuarded(root, rel, VAULT_FILE_MAX_BYTES) } catch (error) {
        if (error instanceof GuardedWriteRefused && error.code === 'is-a-link') return { state: 'invalid', reason: 'is-a-link' }
        if (error instanceof RangeError) return { state: 'invalid', reason: 'too-large' }
        return { state: 'invalid', reason: 'unreadable' }
      }
      if (!got) return { state: 'none' }
      const parsed = parseVaultFile(Buffer.from(got.bytes).toString('utf8'))
      if (parsed.state !== 'ok') return parsed
      return { state: 'ok', file: parsed.file, sha256: got.sha256, ours: ours(parsed.file) }
    },
    async create(root, fields) {
      const file = Object.assign(Object.create(null), { schema: spec.schema, ...fields }) as VaultFile
      checkValues(file)
      try { await createFile(root, rel, vaultFileBytes(file), { makeFolders: true, mode: 0o644 }) } catch (error) { refusal(error) }
      return file
    },
    async update(root, read, patch) {
      if (!read.ours) throw new VaultFileError('newer-schema', 'This vault was made by a newer version of the app; it is not changed.')
      const file = Object.assign(Object.create(null), read.file) as VaultFile
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'id' || key === 'schema') continue
        if (value === undefined) delete file[key]
        else file[key] = value
      }
      checkValues(file)
      try { await rewriteFile(root, rel, vaultFileBytes(file), { expect: read.sha256 }) } catch (error) { refusal(error) }
      return file
    },
  }
}

export { sha256Hex }
