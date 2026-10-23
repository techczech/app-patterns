// The marker file (ported from TalkWeaver test-vault-file, parameterised) and folder availability
// (T-AV-1, ported from test-vault-availability: injected probe states).
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVaultAvailability, nodeAvailabilityProbe, serviceFor, vaultUnavailability, type AvailabilityProbe, type RootState } from './availability.ts'
import { createVaultFileStore, parseVaultFile, VaultFileError } from './vault-file.ts'

const base = realpathSync(mkdtempSync(join(tmpdir(), 'vf-marker-')))
afterAll(() => rmSync(base, { recursive: true, force: true }))
let n = 0
const vault = (): string => { const d = join(base, `v${++n}`); mkdirSync(d); return d }
const store = createVaultFileStore({ dir: '.learnweaver', name: 'library.json', schema: 1 })

test('create, read, update: unknown keys kept in place, schema ownership, id pattern', async () => {
  const root = vault()
  expect(await store.read(root)).toEqual({ state: 'none' })
  await store.create(root, { id: 'lib-1', name: 'My library', created_at: '2026-10-22T18:00:00.000Z' })
  const read = await store.read(root)
  expect(read.state).toBe('ok')
  if (read.state !== 'ok') return
  expect(read.ours).toBe(true)
  expect({ ...read.file }).toEqual({ schema: 1, id: 'lib-1', name: 'My library', created_at: '2026-10-22T18:00:00.000Z' })
  // A newer build's key, then our update: kept, in place.
  const text = readFileSync(join(root, '.learnweaver/library.json'), 'utf8').replace('"name"', '"colour": "green",\n  "name"')
  writeFileSync(join(root, '.learnweaver/library.json'), text)
  const again = await store.read(root)
  if (again.state !== 'ok') throw new Error('unreadable')
  await store.update(root, again, { name: 'Renamed' })
  const after = JSON.parse(readFileSync(join(root, '.learnweaver/library.json'), 'utf8'))
  expect(Object.keys(after)).toEqual(['schema', 'id', 'colour', 'name', 'created_at'])
  expect(after.name).toBe('Renamed')
  expect(after.colour).toBe('green')
  await expect(store.create(root, { id: 'lib-2' })).rejects.toMatchObject({ reason: 'exists' })
})

test('update refuses when the file changed since it was read, and a newer schema is never written', async () => {
  const root = vault()
  await store.create(root, { id: 'lib-1', name: 'A' })
  const read = await store.read(root)
  if (read.state !== 'ok') throw new Error('unreadable')
  writeFileSync(join(root, '.learnweaver/library.json'), JSON.stringify({ schema: 1, id: 'lib-1', name: 'B' }))
  await expect(store.update(root, read, { name: 'C' })).rejects.toMatchObject({ reason: 'changed' })
  writeFileSync(join(root, '.learnweaver/library.json'), JSON.stringify({ schema: 2, id: 'lib-1', name: 'B' }))
  const newer = await store.read(root)
  expect(newer.state === 'ok' && newer.ours).toBe(false)
  if (newer.state === 'ok') await expect(store.update(root, newer, { name: 'C' })).rejects.toMatchObject({ reason: 'newer-schema' })
})

test('no absolute path or address may be written; bad ids refused; invalid files reported, never written over', async () => {
  const root = vault()
  await expect(store.create(root, { id: 'lib-1', name: '/Users/someone/Library' })).rejects.toBeInstanceOf(VaultFileError)
  await expect(store.create(root, { id: 'lib-1', name: 'x', extra: { url: 'https://example.com' } })).rejects.toMatchObject({ reason: 'absolute-path' })
  await expect(store.create(root, { id: 'bad id!' })).rejects.toMatchObject({ reason: 'bad-id' })
  expect(parseVaultFile('[]')).toEqual({ state: 'invalid', reason: 'not-json' })
  expect(parseVaultFile('{"name":"x"}')).toEqual({ state: 'invalid', reason: 'no-id' })
  expect(parseVaultFile('{"id":"../x"}')).toEqual({ state: 'invalid', reason: 'bad-id' })
  mkdirSync(join(root, '.learnweaver'))
  writeFileSync(join(root, '.learnweaver/library.json'), 'x'.repeat(1024 * 1024 + 1))
  expect(await store.read(root)).toEqual({ state: 'invalid', reason: 'too-large' })
})

test('a marker folder or file that is a link is refused', async () => {
  const root = vault()
  const elsewhere = vault()
  mkdirSync(join(elsewhere, '.learnweaver'))
  writeFileSync(join(elsewhere, '.learnweaver/library.json'), JSON.stringify({ id: 'other' }))
  symlinkSync(join(elsewhere, '.learnweaver'), join(root, '.learnweaver'))
  expect(await store.read(root)).toEqual({ state: 'invalid', reason: 'is-a-link' })
  await expect(store.create(root, { id: 'lib-1', name: 'x' })).rejects.toThrow()
  expect(JSON.parse(readFileSync(join(elsewhere, '.learnweaver/library.json'), 'utf8'))).toEqual({ id: 'other' })
})

const probeOf = (states: Record<string, RootState>, existing: string[] = []): AvailabilityProbe => ({
  home: '/Users/t',
  state: async (p) => states[p] ?? 'missing',
  exists: async (p) => existing.includes(p),
})

test('availability: each reason from the injected probe', async () => {
  const od = '/Users/t/Library/CloudStorage/OneDrive-Personal/Library'
  expect(await vaultUnavailability(od, 'OneDrive', probeOf({ [od]: 'dir' }))).toBeNull()
  expect((await vaultUnavailability(od, 'OneDrive', probeOf({}, [])))?.reason).toBe('not-signed-in')
  expect((await vaultUnavailability(od, 'OneDrive', probeOf({}, ['/Users/t/Library/CloudStorage/OneDrive-Personal'])))?.reason).toBe('folder-moved')
  expect((await vaultUnavailability('/Volumes/x/lib', 'Local', probeOf({}))))?.toMatchObject({ reason: 'folder-not-found' })
  const denied = await vaultUnavailability('/a', 'Local', probeOf({ '/a': 'denied' }), 'LearnWeaver')
  expect(denied?.reason).toBe('no-permission')
  expect(denied?.message).toContain('LearnWeaver has no permission')
  const slow: AvailabilityProbe = { home: '/Users/t', state: () => new Promise(() => {}), exists: async () => true }
  const availability = createVaultAvailability({ probe: slow, serviceOf: () => 'Local', serviceFromPath: () => 'Local', timeoutMs: 20 })
  await availability.check([{ id: 'lib', root: '/slow', open: true }])
  expect(availability.status('lib')?.reason).toBe('not-responding')
  expect(serviceFor(od, { home: '/Users/t', exists: () => false })).toBe('OneDrive')
})

test('availability: the real probe on a temp folder', async () => {
  const root = vault()
  const probe = nodeAvailabilityProbe(base)
  expect(await probe.state(root)).toBe('dir')
  expect(await probe.state(join(root, 'missing'))).toBe('missing')
  writeFileSync(join(root, 'file'), 'x')
  expect(await probe.state(join(root, 'file'))).toBe('not-dir')
})
