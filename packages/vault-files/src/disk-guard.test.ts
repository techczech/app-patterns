// T-ED-1 (package part): the external-change guard with the guarded rewrite, over a temp vault
// (ported from TalkWeaver test-outline-disk-guard, cases 1-5).
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createDiskGuard, hashText, type DiskChange } from './disk-guard.ts'
import { GuardedWriteRefused, rewriteFile, withFileLock } from './guarded-write.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'vf-guard-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const TEXT = '---\ntitle: Guarded\n---\n\n## One {id=aa11}\n'
let seq = 0
const file = (text = TEXT): string => {
  const dir = join(root, `lesson-${++seq}`)
  mkdirSync(dir)
  const path = join(dir, `lesson-${seq}-outline.md`)
  writeFileSync(path, text)
  return path
}
const notices: { owner: string; change: DiskChange | null }[] = []
const guard = createDiskGuard({
  canonical: (p) => { try { return realpathSync(p) } catch { return p } },
  async readText(realPath) { try { return await readFile(realPath, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error } },
  async mtime(realPath) { try { return statSync(realPath).mtimeMs } catch { return null } },
  withLock: (path, work) => withFileLock(path, work),
  notify: (owner, _path, change) => notices.push({ owner, change }),
})

/** What an app's editor save does: ask the guard, then rewrite against the version it read. */
async function save(path: string, text: string): Promise<{ ok: true } | { ok: false; change: DiskChange | null; code?: string }> {
  const real = (() => { try { return realpathSync(path) } catch { return path } })()
  const disk = await readFile(real, 'utf8').catch(() => null)
  const change = await guard.conflict(real, disk, text)
  if (change) return { ok: false, change }
  try {
    await rewriteFile(root, relative(root, real), text, { expect: hashText(disk ?? '') })
  } catch (error) {
    return { ok: false, change: null, code: error instanceof GuardedWriteRefused ? error.code : String(error) }
  }
  guard.written(real, text)
  return { ok: true }
}

test('an outside change refuses the save, names the version on disk, and is reported once', async () => {
  notices.length = 0
  const path = file()
  guard.track('w1', path, TEXT)
  const theirs = TEXT + '\n## Theirs\n'
  writeFileSync(path, theirs)
  const refused = await save(path, TEXT + '\n## Mine\n')
  expect(refused.ok).toBe(false)
  expect(!refused.ok && refused.change?.kind).toBe('changed')
  expect(!refused.ok && refused.change?.hash).toBe(hashText(theirs))
  expect(readFileSync(path, 'utf8')).toBe(theirs)
  await save(path, TEXT + '\n## Mine again\n')
  expect(notices.filter((n) => n.owner === 'w1' && n.change).length).toBe(1)
  expect(guard.pendingFor('w1')?.kind).toBe('changed')
  guard.release('w1')
  expect(guard.pendingFor('w1')).toBeNull()
})

test('own saves are the new baseline; a check after them reports nothing', async () => {
  notices.length = 0
  const path = file()
  guard.track('w2', path, TEXT)
  for (let i = 0; i < 3; i += 1) expect((await save(path, `${TEXT}\n## Save ${i}\n`)).ok).toBe(true)
  expect(await guard.check(path)).toBeNull()
  expect(notices).toEqual([])
  guard.release('w2')
})

test('a rename-replace is a change; going back to the baseline clears it', async () => {
  notices.length = 0
  const path = file()
  guard.track('w3', path, TEXT)
  const temp = join(path, '..', '.sync-tmp')
  writeFileSync(temp, TEXT + '\n## Renamed over\n')
  renameSync(temp, path)
  expect((await guard.check(path))?.kind).toBe('changed')
  writeFileSync(path, TEXT)
  expect(await guard.check(path)).toBeNull()
  expect(notices.at(-1)?.change).toBeNull()
  guard.release('w3')
})

test('the same edit on both sides is accepted silently', async () => {
  notices.length = 0
  const path = file()
  guard.track('w4', path, TEXT)
  const same = TEXT + '\n## Same\n'
  writeFileSync(path, same)
  expect((await save(path, same)).ok).toBe(true)
  expect(notices).toEqual([])
  guard.release('w4')
})

test('a removed file is reported and never re-created by a save; accept(removed) then a save still cannot re-create it', async () => {
  const path = file()
  guard.track('w5', path, TEXT)
  const real = realpathSync(path)
  unlinkSync(path)
  const change = await guard.check(real)
  expect(change?.kind).toBe('removed')
  expect((await save(real, TEXT + 'x')).ok).toBe(false)
  expect(() => statSync(real)).toThrow()
  expect((await guard.accept(real, 'removed')).ok).toBe(true)
  guard.release('w5')
})

test('accept with a stale hash is refused with the newer change', async () => {
  const path = file()
  guard.track('w6', path, TEXT)
  writeFileSync(path, 'first outside\n')
  const first = await guard.check(path)
  writeFileSync(path, 'second outside\n')
  const accepted = await guard.accept(path, first!.hash)
  expect(accepted.ok).toBe(false)
  expect(!accepted.ok && accepted.change?.hash).toBe(hashText('second outside\n'))
  expect((await guard.accept(path, hashText('second outside\n'))).ok).toBe(true)
  guard.release('w6')
})

test('failedHalfway reports a partial change that is never offered as a version to reload', async () => {
  const path = file()
  guard.track('w7', path, TEXT)
  const real = realpathSync(path)
  const change = guard.failedHalfway(real, '/tmp/x.vf-write')
  expect(change?.kind).toBe('partial')
  expect((await guard.accept(path, hashText(TEXT))).ok).toBe(false)
  expect((await guard.accept(path, 'partial:/tmp/x.vf-write')).ok).toBe(true)
  guard.release('w7')
})
