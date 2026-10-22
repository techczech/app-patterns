import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nodeAvailabilityProbe, serviceFor, vaultUnavailability, withTimeout, notResponding, type AvailabilityProbe, type RootState } from './availability.js'

// T-AV-1: availability states through an injected probe, and the real probe on a temp folder.
const HOME = '/Users/t'
const probe = (state: RootState, existing: string[] = []): AvailabilityProbe => ({ home: HOME, state: async () => state, exists: async (p: string) => existing.includes(p) })

describe('vaultUnavailability', () => {
  test('a folder that opens is available', async () => {
    expect(await vaultUnavailability('/Users/t/Lib', 'Local', probe('dir'))).toBeNull()
  })
  test('refused by the system: no permission, naming the app', async () => {
    const r = await vaultUnavailability('/Users/t/Lib', 'Local', probe('denied'), 'LearnWeaver')
    expect(r?.reason).toBe('no-permission'); expect(r?.message).toContain('LearnWeaver has no permission')
  })
  test('cloud folder whose mount is gone: not signed in, with the service settings action', async () => {
    const root = '/Users/t/Library/CloudStorage/OneDrive-Oxford/Library'
    const r = await vaultUnavailability(root, 'OneDrive', probe('missing'))
    expect([r?.reason, r?.action, r?.actionLabel]).toEqual(['not-signed-in', 'open-service', 'Open OneDrive settings'])
  })
  test('missing with its parent there: moved; with no parent: not found', async () => {
    expect((await vaultUnavailability('/Users/t/Docs/Lib', 'Local', probe('missing', ['/Users/t/Docs'])))?.reason).toBe('folder-moved')
    expect((await vaultUnavailability('/Volumes/X/Lib', 'Local', probe('missing')))?.reason).toBe('folder-not-found')
  })
  test('a check that does not answer in time reads as not responding', async () => {
    const r = await withTimeout(new Promise<null>(() => {}), 20, notResponding)
    expect(r?.reason).toBe('not-responding')
  })
})

describe('serviceFor and the real probe', () => {
  test('services by folder', () => {
    const exists = () => false
    expect(serviceFor('/Users/t/Library/CloudStorage/OneDrive-Oxford/L', { home: HOME, exists })).toBe('OneDrive')
    expect(serviceFor('/Users/t/Library/CloudStorage/Dropbox/L', { home: HOME, exists })).toBe('Dropbox')
    expect(serviceFor('/Users/t/Documents/L', { home: HOME, exists })).toBe('Local')
    expect(serviceFor('/Users/t/repo/L', { home: HOME, exists: (p: string) => p === '/Users/t/repo/.git' })).toBe('Git')
  })
  test('nodeAvailabilityProbe: folder, file, missing', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'vf-av-')))
    try {
      mkdirSync(join(dir, 'lib')); writeFileSync(join(dir, 'file'), 'x')
      const p = nodeAvailabilityProbe(dir)
      expect(await p.state(join(dir, 'lib'))).toBe('dir')
      expect(await p.state(join(dir, 'file'))).toBe('not-dir')
      expect(await p.state(join(dir, 'gone'))).toBe('missing')
      expect(await p.exists(join(dir, 'lib'))).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
