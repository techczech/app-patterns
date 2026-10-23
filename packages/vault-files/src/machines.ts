// Machine names seen per vault (taken from TalkWeaver `vault-machines.ts`). A OneDrive conflict copy
// `S-<Machine>.md` counts when <Machine> is this Mac's name or another machine seen for the vault
// (conflict-copies.mjs rule (a)). Kept in app data (`userData/vault-machines.json`,
// `{ [vaultId]: string[] }`), never in the vault. This Mac's names (hostname, ComputerName) are
// slugged the way OneDrive writes them and stored for each vault the first time it is asked about.

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import { machineSlug } from './conflict-copies.ts'

export interface VaultMachines {
  /** Every machine name known for the vault, this Mac's first. */
  known(vaultId: string): string[]
  /** Remember machine names seen for the vault (deduplicated ignoring case). */
  remember(vaultId: string, names: string[]): void
}

const MAX_PER_VAULT = 64

/** `thisMac` may be a function: it is then asked once, on first use (not at app start). */
export function createVaultMachines({ file, thisMac }: { file: string; thisMac: string[] | (() => string[]) }): VaultMachines {
  let mineCache: string[] | null = null
  const mineNames = (): string[] => {
    if (!mineCache) {
      let raw: string[] = []
      try { raw = typeof thisMac === 'function' ? thisMac() : thisMac } catch { raw = [] }
      mineCache = [...new Set(raw.map(machineSlug).filter(Boolean))]
    }
    return mineCache
  }
  let cache: Record<string, string[]> | null = null

  function load(): Record<string, string[]> {
    if (cache) return cache
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch { cache = {} }
    return cache!
  }
  function save(all: Record<string, string[]>): void {
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify(all, null, 2), 'utf8')
      renameSync(tmp, file)
    } catch { /* best effort: rule (b) still recognises most machine names */ }
  }
  function merge(existing: string[], add: string[]): string[] {
    const out = [...existing]
    for (const n of add.map(machineSlug)) {
      if (n && !out.some((m) => m.toLowerCase() === n.toLowerCase())) out.push(n)
    }
    return out.slice(0, MAX_PER_VAULT)
  }

  function remember(vaultId: string, names: string[]): void {
    if (!vaultId) return
    const all = load()
    const before = Array.isArray(all[vaultId]) ? all[vaultId].filter((n) => typeof n === 'string') : []
    const after = merge(before, names)
    if (after.length === before.length) return
    all[vaultId] = after
    save(all)
  }

  function known(vaultId: string): string[] {
    const mine = mineNames()
    if (!vaultId) return mine
    remember(vaultId, mine)
    const stored = load()[vaultId]
    return merge(mine, Array.isArray(stored) ? stored.filter((n) => typeof n === 'string') : [])
  }

  return { known, remember }
}
