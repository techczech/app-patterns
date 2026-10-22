// T-GW: guarded create and rewrite (ported from WriteFlex guarded-create-and-rename /
// guarded-commit-without-hard-links / guarded-document-save and TalkWeaver test-talk-writer).
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import * as fsp from 'node:fs/promises'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFile, GuardedWriteRefused, makeFolder, readFileGuarded, rewriteFile, sha256Hex, TEMP_SUFFIX } from './guarded-write.ts'

let root: string
let outside: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'vf-gw-')))
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'vf-gw-outside-')))
  mkdirSync(join(root, 'course'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})
const code = async (work: Promise<unknown>): Promise<string> => work.then(() => 'written', (error) => error instanceof GuardedWriteRefused ? error.code : `error: ${error?.message}`)
const temps = (dir: string): string[] => readdirSync(dir).filter((f) => f.endsWith(TEMP_SUFFIX))

test('create writes a new file and returns its hash; an existing name is refused and left as it is', async () => {
  const made = await createFile(root, 'course/course.md', '# Course\n')
  expect(readFileSync(join(root, 'course/course.md'), 'utf8')).toBe('# Course\n')
  expect(made.sha256).toBe(sha256Hex('# Course\n'))
  expect(statSync(join(root, 'course/course.md')).mode & 0o777).toBe(0o644)
  expect(await code(createFile(root, 'course/course.md', 'other'))).toBe('exists')
  expect(readFileSync(join(root, 'course/course.md'), 'utf8')).toBe('# Course\n')
  expect(temps(join(root, 'course'))).toEqual([])
})

test('create refuses a name taken between the check and the commit', async () => {
  const result = await code(createFile(root, 'course/late.md', 'mine', { seams: { betweenCheckAndWrite: async () => { writeFileSync(join(root, 'course/late.md'), 'theirs') } } }))
  expect(result).toBe('exists')
  expect(readFileSync(join(root, 'course/late.md'), 'utf8')).toBe('theirs')
  expect(temps(join(root, 'course'))).toEqual([])
})

test('create refuses links: a link at the name, a linked folder on the path, a folder swapped for a link', async () => {
  symlinkSync(join(outside, 'target.md'), join(root, 'course/link.md'))
  expect(await code(createFile(root, 'course/link.md', 'x'))).toBe('is-a-link')
  symlinkSync(outside, join(root, 'away'))
  expect(await code(createFile(root, 'away/file.md', 'x'))).toBe('is-a-link')
  mkdirSync(join(root, 'swap'))
  const result = await code(createFile(root, 'swap/file.md', 'x', { seams: { betweenCheckAndWrite: async () => { renameSync(join(root, 'swap'), join(root, 'swap-old')); symlinkSync(outside, join(root, 'swap')) } } }))
  expect(['swapped', 'is-a-link']).toContain(result)
  expect(readdirSync(outside)).toEqual([])
})

test('create refuses paths that leave the folder and never creates the vault root', async () => {
  for (const rel of ['../x.md', '/etc/x', 'a/../../x', 'a\\b.md', '', 'C:/x']) expect(await code(createFile(root, rel, 'x'))).toBe('outside')
  expect(await code(createFile(join(root, 'missing-root'), 'x.md', 'x'))).toBe('no-vault')
  expect(existsSync(join(root, 'missing-root'))).toBe(false)
  expect(await code(createFile(root, 'nofolder/x.md', 'x'))).toBe('no-folder')
  await createFile(root, 'new/deep/x.md', 'x', { makeFolders: true })
  expect(readFileSync(join(root, 'new/deep/x.md'), 'utf8')).toBe('x')
})

test('makeFolder refuses a link on the way and is fine with existing folders', async () => {
  await makeFolder(root, 'course/lesson/assets')
  await makeFolder(root, 'course/lesson/assets')
  expect(statSync(join(root, 'course/lesson/assets')).isDirectory()).toBe(true)
  symlinkSync(outside, join(root, 'course/linked'))
  expect(await code(makeFolder(root, 'course/linked/sub'))).toBe('is-a-link')
  expect(readdirSync(outside)).toEqual([])
})

for (const failure of ['ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV']) {
  test(`create fails closed on ${failure}, preserving a concurrently created foreign file`, async () => {
    const path = join(root, 'course/nolinks.md')
    const spy = spyOn(fsp, 'link').mockImplementation(async () => {
      writeFileSync(path, 'foreign')
      throw Object.assign(new Error('not supported'), { code: failure })
    })
    try {
      const error = await createFile(root, 'course/nolinks.md', 'mine').catch((e) => e)
      expect(error.code).toBe(failure)
      expect(readFileSync(path, 'utf8')).toBe('foreign')
      expect(spy).toHaveBeenCalledTimes(1)
    } finally { spy.mockRestore() }
  })
}

test('create never invokes an overwriting rename when hard links are unsupported', async () => {
  const originalRename = fsp.rename
  const linkSpy = spyOn(fsp, 'link').mockImplementation(async () => {
    throw Object.assign(new Error('not supported'), { code: 'EPERM' })
  })
  const renameSpy = spyOn(fsp, 'rename').mockImplementation(async (source, target) => {
    writeFileSync(String(target), 'foreign created after the last existence check')
    return originalRename(source, target)
  })
  try {
    const error = await createFile(root, 'course/nolinks.md', 'mine').catch((e) => e)
    expect(error.code).toBe('EPERM')
    expect(renameSpy).not.toHaveBeenCalled()
    expect(existsSync(join(root, 'course/nolinks.md'))).toBe(false)
  } finally { linkSpy.mockRestore(); renameSpy.mockRestore() }
})

test('create detects a directory moved outside during link and keeps owned recovery bytes', async () => {
  const originalLink = fsp.link
  const moved = join(outside, 'moved')
  const spy = spyOn(fsp, 'link').mockImplementation(async (source, target) => {
    renameSync(join(root, 'course'), moved)
    symlinkSync(moved, join(root, 'course'))
    return originalLink(source, target)
  })
  try {
    const error = await createFile(root, 'course/late.md', 'mine').catch((e) => e)
    expect(error).toBeInstanceOf(GuardedWriteRefused)
    expect(error.code).toBe('swapped')
    expect(temps(moved)).toHaveLength(1)
    expect(readFileSync(join(moved, temps(moved)[0]!), 'utf8')).toBe('mine')
  } finally { spy.mockRestore() }
})

test('create refuses a swap during staging before attempting final link', async () => {
  const originalOpen = fsp.open
  const moved = join(outside, 'moved')
  const linkSpy = spyOn(fsp, 'link')
  const openSpy = spyOn(fsp, 'open').mockImplementation(async (path, flags, mode) => {
    const handle = await originalOpen(path, flags, mode)
    if (String(path).endsWith(TEMP_SUFFIX)) {
      const sync = handle.sync.bind(handle)
      spyOn(handle, 'sync').mockImplementation(async () => {
        await sync()
        renameSync(join(root, 'course'), moved)
        symlinkSync(moved, join(root, 'course'))
      })
    }
    return handle
  })
  try {
    const error = await createFile(root, 'course/late.md', 'mine').catch((e) => e)
    expect(error.code).toBe('swapped')
    expect(linkSpy).not.toHaveBeenCalled()
    expect(existsSync(join(moved, 'late.md'))).toBe(false)
    expect(error.recoveryComplete).toBe(true)
    expect(readFileSync(join(moved, error.recoveryName), 'utf8')).toBe('mine')
  } finally { openSpy.mockRestore(); linkSpy.mockRestore() }
})

test('create never overwrites an external file when the directory swaps at link', async () => {
  const originalLink = fsp.link
  const moved = join(outside, 'moved')
  const spy = spyOn(fsp, 'link').mockImplementation(async (source, target) => {
    renameSync(join(root, 'course'), moved)
    symlinkSync(moved, join(root, 'course'))
    writeFileSync(join(moved, 'late.md'), 'foreign')
    return originalLink(source, target)
  })
  try {
    const error = await createFile(root, 'course/late.md', 'mine').catch((e) => e)
    expect(error.code).toBe('swapped')
    expect(readFileSync(join(moved, 'late.md'), 'utf8')).toBe('foreign')
    expect(readFileSync(join(moved, error.recoveryName), 'utf8')).toBe('mine')
  } finally { spy.mockRestore() }
})

test('create cleanup does not unlink a foreign stage through a swapped directory', async () => {
  let foreign = ''
  const spy = spyOn(fsp, 'link').mockImplementation(async (source, target) => {
    const name = String(source).split('/').at(-1)!
    renameSync(join(root, 'course'), join(outside, 'moved'))
    mkdirSync(join(root, 'course'))
    foreign = join(root, 'course', name)
    writeFileSync(foreign, 'foreign')
    throw Object.assign(new Error('link failed'), { code: 'EIO' })
  })
  try {
    await expect(createFile(root, 'course/late.md', 'mine')).rejects.toThrow()
    expect(readFileSync(foreign, 'utf8')).toBe('foreign')
    const moved = join(outside, 'moved')
    expect(readFileSync(join(moved, temps(moved)[0]!), 'utf8')).toBe('mine')
  } finally { spy.mockRestore() }
})

test('rewrite writes singly-linked files in place, retaining inode and mode', async () => {
  const path = join(root, 'course/course.md')
  writeFileSync(path, 'one\n')
  chmodSync(path, 0o640)
  const ino = statSync(path).ino
  const res = await rewriteFile(root, 'course/course.md', 'two, longer\n', { expect: sha256Hex('one\n') })
  expect(res.changed).toBe(true)
  expect(statSync(path).ino).toBe(ino)
  expect(statSync(path).mode & 0o777).toBe(0o640)
  expect(temps(join(root, 'course'))).toEqual([])
})

test('rewrite refuses an existing hard link without modifying its external alias', async () => {
  const path = join(root, 'course/course.md')
  const alias = join(outside, 'alias.md')
  writeFileSync(path, 'old')
  linkSync(path, alias)
  expect(await code(rewriteFile(root, 'course/course.md', 'new', { expect: sha256Hex('old') }))).toBe('changed')
  expect(readFileSync(path, 'utf8')).toBe('old')
  expect(readFileSync(alias, 'utf8')).toBe('old')
  expect(temps(join(root, 'course'))).toEqual([])
})

test('rewrite rechecks the opened handle for a hard link created after the path check', async () => {
  const path = join(root, 'course/course.md')
  const alias = join(outside, 'alias.md')
  writeFileSync(path, 'old')
  const result = await code(rewriteFile(root, 'course/course.md', 'new', {
    expect: sha256Hex('old'),
    seams: { betweenCheckAndWrite: async () => { linkSync(path, alias) } },
  }))
  expect(result).toBe('changed')
  expect(readFileSync(alias, 'utf8')).toBe('old')
  expect(temps(join(root, 'course'))).toEqual([])
})

test('rewrite rechecks link count after reading the actual handle, before truncation', async () => {
  const path = join(root, 'course/course.md')
  const alias = join(outside, 'alias.md')
  writeFileSync(path, 'old')
  const originalOpen = fsp.open
  const spy = spyOn(fsp, 'open').mockImplementation(async (name, flags, mode) => {
    const handle = await originalOpen(name, flags, mode)
    if (String(name) === path) {
      const read = handle.readFile.bind(handle)
      spyOn(handle, 'readFile').mockImplementation((async () => {
        const bytes = await read()
        linkSync(path, alias)
        return bytes
      }) as typeof handle.readFile)
    }
    return handle
  })
  try {
    expect(await code(rewriteFile(root, 'course/course.md', 'new', { expect: sha256Hex('old') }))).toBe('changed')
    expect(readFileSync(alias, 'utf8')).toBe('old')
  } finally { spy.mockRestore() }
})

test('rewrite refuses when the file changed since it was read, also between the check and the write', async () => {
  const path = join(root, 'course/course.md')
  writeFileSync(path, 'mine\n')
  writeFileSync(path, 'theirs\n')
  expect(await code(rewriteFile(root, 'course/course.md', 'new\n', { expect: sha256Hex('mine\n') }))).toBe('changed')
  expect(readFileSync(path, 'utf8')).toBe('theirs\n')
  const late = await code(rewriteFile(root, 'course/course.md', 'new\n', { expect: sha256Hex('theirs\n'), seams: { betweenCheckAndWrite: async () => { writeFileSync(path, 'later\n') } } }))
  expect(late).toBe('changed')
  expect(readFileSync(path, 'utf8')).toBe('later\n')
  expect(temps(join(root, 'course'))).toEqual([])
})

test('rewrite never re-creates a removed file, refuses links and read-only files', async () => {
  expect(await code(rewriteFile(root, 'course/gone.md', 'x', { expect: sha256Hex('') }))).toBe('not-a-file')
  expect(existsSync(join(root, 'course/gone.md'))).toBe(false)
  writeFileSync(join(outside, 'target.md'), 'outside\n')
  symlinkSync(join(outside, 'target.md'), join(root, 'course/link.md'))
  expect(await code(rewriteFile(root, 'course/link.md', 'x', { expect: sha256Hex('outside\n') }))).toBe('is-a-link')
  expect(readFileSync(join(outside, 'target.md'), 'utf8')).toBe('outside\n')
  writeFileSync(join(root, 'course/ro.md'), 'ro\n')
  chmodSync(join(root, 'course/ro.md'), 0o444)
  expect(await code(rewriteFile(root, 'course/ro.md', 'x', { expect: sha256Hex('ro\n') }))).toBe('read-only')
  expect(readFileSync(join(root, 'course/ro.md'), 'utf8')).toBe('ro\n')
})

test('rewrite of identical bytes writes nothing', async () => {
  const path = join(root, 'course/same.md')
  writeFileSync(path, 'same\n')
  const before = statSync(path).mtimeMs
  const res = await rewriteFile(root, 'course/same.md', 'same\n', { expect: sha256Hex('same\n') })
  expect(res.changed).toBe(false)
  expect(statSync(path).mtimeMs).toBe(before)
})

test('a rewrite that fails after truncating keeps the temp file with the full text and names it', async () => {
  const path = join(root, 'course/partial.md')
  writeFileSync(path, 'old\n')
  const error = await rewriteFile(root, 'course/partial.md', 'the whole new text\n', { expect: sha256Hex('old\n'), seams: { afterTruncate: async () => { throw new Error('disk full') } } }).then(() => null, (e) => e)
  expect(error?.partialTemp).toBeString()
  expect(readFileSync(error.partialTemp, 'utf8')).toBe('the whole new text\n')
  expect(error.message).toContain(error.partialTemp)
})

test('a rewrite whose file is replaced by another program during the write is not reported as done', async () => {
  const path = join(root, 'course/replaced.md')
  writeFileSync(path, 'old\n')
  const error = await rewriteFile(root, 'course/replaced.md', 'new\n', {
    expect: sha256Hex('old\n'),
    seams: { afterWrite: async () => { writeFileSync(join(root, 'course/other'), 'other\n'); renameSync(join(root, 'course/other'), path) } },
  }).then(() => null, (e) => e)
  expect(error?.landed).toBe(true)
})

test('concurrent rewrites of one file run one at a time: the second sees the first and is refused', async () => {
  const path = join(root, 'course/race.md')
  writeFileSync(path, 'base\n')
  const base = sha256Hex('base\n')
  const results = await Promise.all([
    code(rewriteFile(root, 'course/race.md', 'first\n', { expect: base })),
    code(rewriteFile(root, 'course/race.md', 'second\n', { expect: base })),
  ])
  expect(results).toEqual(['written', 'changed'])
  expect(readFileSync(path, 'utf8')).toBe('first\n')
})

test('readFileGuarded: bytes and hash, null when missing, links refused, size cap', async () => {
  writeFileSync(join(root, 'course/a.md'), 'abc')
  const got = await readFileGuarded(root, 'course/a.md')
  expect(Buffer.from(got!.bytes).toString()).toBe('abc')
  expect(got!.sha256).toBe(sha256Hex('abc'))
  expect(await readFileGuarded(root, 'course/none.md')).toBeNull()
  symlinkSync(join(root, 'course/a.md'), join(root, 'course/l.md'))
  expect(await code(readFileGuarded(root, 'course/l.md'))).toBe('is-a-link')
  await expect(readFileGuarded(root, 'course/a.md', 2)).rejects.toBeInstanceOf(RangeError)
})
