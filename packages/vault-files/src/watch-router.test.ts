// T-W-1 (package part): the watch router (ported from WriteFlex workspace-watcher.test.ts), extended
// with own-write suppression by path + hash, and one real recursive watch over a temp folder.
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFile, readFileGuarded, sha256Hex } from './guarded-write.ts'
import { createFolderWatcher, createIgnoreRule, createWatchRouter, OwnWriteTracker } from './watch-router.ts'

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('ignored paths: dot segments (except allowed), temp files, absolute and escaping paths', () => {
  const ignore = createIgnoreRule(['.learnweaver/library.json'])
  expect(ignore('.learnweaver/library.json')).toBe(false)
  expect(ignore('.learnweaver/migration-x.md')).toBe(true)
  expect(ignore('course/.course.md.abc.vf-write')).toBe(true)
  expect(ignore('course/x.tmp')).toBe(true)
  expect(ignore('/abs/path')).toBe(true)
  expect(ignore('../out')).toBe(true)
  expect(ignore('course/lesson/lesson-outline.md')).toBe(false)
})

test('a burst collapses into one sorted report after the debounce', async () => {
  const seen: string[][] = []
  const router = createWatchRouter({}, (paths) => seen.push(paths), 20)
  router.take('b.md')
  router.take('a.md')
  router.take('b.md')
  router.take('.hidden/x')
  await wait(60)
  expect(seen).toEqual([['a.md', 'b.md']])
  router.dispose()
})

test('own write suppressed by path + hash; a foreign write to the same path within the window is still seen', async () => {
  const files = new Map<string, string>()
  const own = new OwnWriteTracker()
  const seen: string[][] = []
  const router = createWatchRouter({ ownWrites: own, hashOf: async (p) => (files.has(p) ? sha256Hex(files.get(p)!) : null) }, (paths) => seen.push(paths), 10)
  files.set('course.md', 'ours')
  own.record('course.md', sha256Hex('ours'))
  router.take('course.md')
  await router.flushNow()
  expect(seen).toEqual([])
  files.set('course.md', 'theirs')
  router.take('course.md')
  await router.flushNow()
  expect(seen).toEqual([['course.md']])
  // After the window, the path is reported whatever it holds.
  const later = new OwnWriteTracker(0)
  later.record('x.md', sha256Hex('ours'), Date.now() - 10)
  expect(later.isOwnWrite('x.md', sha256Hex('ours'))).toBe(false)
  router.dispose()
})

test('a real recursive watch over a temp folder reports a foreign write and suppresses the app\'s own', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'vf-watch-')))
  try {
    mkdirSync(join(root, 'course'))
    const own = new OwnWriteTracker()
    const seen: string[] = []
    const router = createWatchRouter({ ownWrites: own, hashOf: async (p) => (await readFileGuarded(root, p).catch(() => null))?.sha256 ?? null }, (paths) => seen.push(...paths), 50)
    const watcher = createFolderWatcher(root, router)
    await wait(100)
    const made = await createFile(root, 'course/own.md', 'ours\n')
    own.record('course/own.md', made.sha256)
    writeFileSync(join(root, 'course/foreign.md'), 'theirs\n')
    for (let i = 0; i < 40 && !seen.includes('course/foreign.md'); i += 1) await wait(50)
    watcher.dispose()
    expect(seen).toContain('course/foreign.md')
    expect(seen).not.toContain('course/own.md')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

afterAll(() => {})
