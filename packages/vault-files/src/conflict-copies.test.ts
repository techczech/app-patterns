// T-CC-1: conflict-copy names (the TalkWeaver table, ported), generalised to course.md and
// library.json; the scanner over a real temp folder with an injected trash; machines.
import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { classifyConflict, conflictCandidateNames, conflictServiceOf, createConflictScanner, hasGitConflictMarkers, isMachineName, machineSlug } from './conflict-copies.ts'
import { createVaultMachines } from './machines.ts'
import { pathStaysInside } from './paths.ts'

const S = 'ai-workshop-outline.md'
const table: [string, string | null, (string | null)?][] = [
  // [file name, expected service or null, expected source]
  ['ai-workshop-outline-MacBook-Air.md', 'onedrive', 'MacBook-Air'],
  ['ai-workshop-outline-DESKTOP-4F2K9.md', 'onedrive', 'DESKTOP-4F2K9'],
  ['ai-workshop-outline-Dominiks-MacBook-Pro.md', 'onedrive', 'Dominiks-MacBook-Pro'],
  ['ai-workshop-MacBook-Air-outline.md', 'onedrive', 'MacBook-Air'],
  ["ai-workshop-outline (Dominik Lukeš's conflicted copy 2026-09-30).md", 'dropbox', 'Dominik Lukeš'],
  ['ai-workshop-outline (conflicted copy 2026-09-30 091400).md', 'dropbox', null],
  ['ai-workshop-outline (1).md', 'gdrive', null],
  ['ai-workshop-outline(1).md', 'gdrive', null],
  ['ai-workshop-outline (2).md', 'gdrive', null],
  // non-matches: the author's own siblings and other talks
  ['ai-workshop-outline.md', null],
  ['ai-workshop-notes.md', null],
  ['ai-workshop-outline-notes.md', null],
  ['ai-workshop-outline-v2.md', null],
  ['ai-workshop-2-outline.md', null],
  ['ai-workshop-handout-outline.md', null],
  ['other-talk-outline.md', null],
  ['ai-workshop-outline (draft).md', null],
  ['ai-workshop-outline (123).md', null],
  ['ai-workshop-outline-MacBook-Air.txt', null],
  ['xai-workshop-outline-MacBook-Air.md', null],
  ['ai-workshop-outline-Mac Book.md', null],
  // review S3: rule (b) — whole hyphen-separated tokens that name a machine, or Windows' default names
  ['ai-workshop-outline-iMac.md', 'onedrive', 'iMac'],
  ['ai-workshop-outline-Mac-mini.md', 'onedrive', 'Mac-mini'],
  ['ai-workshop-outline-Mini.md', 'onedrive', 'Mini'],
  ['ai-workshop-outline-Dominiks-Air.md', 'onedrive', 'Dominiks-Air'],
  ['ai-workshop-outline-Anna-Studio.md', 'onedrive', 'Anna-Studio'],
  ['ai-workshop-outline-Office-PC.md', 'onedrive', 'Office-PC'],
  ['ai-workshop-outline-LAPTOP-7Q.md', 'onedrive', 'LAPTOP-7Q'],
  ['ai-workshop-outline-desktop-abc12.md', 'onedrive', 'desktop-abc12'],
  // …and nothing else: tags and words that only contain a machine word are the author's own files
  ['ai-workshop-outline-EN.md', null],
  ['ai-workshop-outline-Draft.md', null],
  ['ai-workshop-outline-V2.md', null],
  ['ai-workshop-outline-final.md', null],
  ['ai-workshop-outline-machine.md', null],
  ['ai-workshop-outline-minimal.md', null],
  ['ai-workshop-outline-topcoat.md', null],
  ['ai-workshop-outline-final-draft.md', null],
  ['ai-workshop-outline-home-server.md', null],
  ['ai-workshop-outline-GamingPC.md', null],
  ['ai-workshop-outline-macek.md', null], // a host name no rule can guess: only rule (a)
  ['ai-workshop-outline-DESKTOP.md', null],
  // a lowercase host name this rule cannot know: only rule (a) (see the next test)
  ['ai-workshop-outline-kestrel.md', null]
]

test(`the naming table (${table.length} rows)`, () => {
  for (const [name, service, source] of table) {
    const got = conflictServiceOf(name, S)
    expect([name, got?.service ?? null]).toEqual([name, service])
    if (service) expect([name, got!.source]).toEqual([name, source ?? null])
  }
})

test('rule (a): a machine name known for the vault counts', () => {
  const known = { knownMachines: ['kestrel.local', 'Dominik’s studio box'] }
  expect(conflictServiceOf('ai-workshop-outline-kestrel.md', S, known)).toEqual({ service: 'onedrive', source: 'kestrel' })
  expect(conflictServiceOf('ai-workshop-outline-Draft.md', S, known)).toBeNull()
  expect(machineSlug('Dominik’s MacBook Air')).toBe('Dominiks-MacBook-Air')
  expect(isMachineName('EN')).toBe(false)
  expect(isMachineName('EN', { loose: true })).toBe(true)
})

test('generalised: course.md and library.json copies by each service; other extensions never match', () => {
  expect(conflictServiceOf('course-MacBook-Air.md', 'course.md')?.service).toBe('onedrive')
  expect(conflictServiceOf('course (1).md', 'course.md')?.service).toBe('gdrive')
  expect(conflictServiceOf("course (Anna's conflicted copy 2026-10-22).md", 'course.md')).toEqual({ service: 'dropbox', source: 'Anna' })
  expect(conflictServiceOf('library-DESKTOP-4F2K9.json', 'library.json')?.service).toBe('onedrive')
  expect(conflictServiceOf('library (1).json', 'library.json')?.service).toBe('gdrive')
  expect(conflictServiceOf('course-notes.md', 'course.md')).toBeNull()
  expect(conflictServiceOf('course-MacBook-Air.json', 'course.md')).toBeNull()
  expect(conflictServiceOf('library', 'library')).toBeNull()
  expect(conflictCandidateNames(['course.md', 'course (1).md', 'lesson', 'course-iMac.md'], 'course.md')).toEqual(['course (1).md', 'course-iMac.md'])
})

const gitTable: [string, boolean][] = [
  ['<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> origin/main\n', true],
  ['intro\n<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\nrest\n', true],
  ['<<<<<<<\na\n=======\nb\n>>>>>>>\n', true],
  ['Title\n=======\n\nText\n', false], // a setext heading underline
  ['  <<<<<<< HEAD\na\n=======\nb\n  >>>>>>> x\n', false], // not at line starts
  ['<<<<<<< HEAD\nno separator\n>>>>>>> x\n', false],
  ['>>>>>>> x\n=======\n<<<<<<< HEAD\n', false], // wrong order
  ['plain text with <<<<<<< inline\n', false],
  // review S2: a conflict shown as code in a fenced block is content, not a conflict
  ['```\n<<<<<<< HEAD\nmine\n=======\ntheirs\n>>>>>>> b\n```\n', false],
  ['~~~text\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> b\n~~~\n', false],
  ['````\n```\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> b\n````\n', false], // an inner shorter fence does not close
  ['```\ncode\n```\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> b\n', true] // after the fence closes, it counts
]
test('git conflict markers', () => {
  for (const [text, want] of gitTable) expect([text, hasGitConflictMarkers(text)]).toEqual([text, want])
})

test('classify: identical, differing, git markers first; an empty canonical never makes a copy identical; json markers checked', () => {
  const copies = classifyConflict([{ name: 'course (1).md', bytes: 'same' }, { name: 'course-iMac.md', bytes: 'other' }, { name: 'course (2).md' }], { name: 'course.md', bytes: 'same' })
  expect(copies.map((c) => [c.name, c.state])).toEqual([['course (1).md', 'identical'], ['course-iMac.md', 'differs'], ['course (2).md', 'differs']])
  expect(classifyConflict([{ name: 'course (1).md', bytes: '' }], { name: 'course.md', bytes: '' })[0]!.state).toBe('differs')
  expect(classifyConflict([], { name: 'course.md', bytes: '<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n' })[0]).toEqual({ name: 'course.md', service: 'git', source: null, state: 'git-markers' })
})

const base = realpathSync(mkdtempSync(join(tmpdir(), 'vf-conflicts-')))
afterAll(() => rmSync(base, { recursive: true, force: true }))

test('scanner: identical copy moved to the injected trash and reported; differing copy only reported; canonical untouched', async () => {
  const folder = join(base, 'course-a')
  const trash = join(base, 'trash')
  mkdirSync(folder)
  mkdirSync(trash)
  writeFileSync(join(folder, 'course.md'), '# Course\n')
  writeFileSync(join(folder, 'course (1).md'), '# Course\n')
  writeFileSync(join(folder, 'course-MacBook-Air.md'), '# Course, edited on the other Mac\n')
  writeFileSync(join(folder, 'course-notes.md'), 'mine\n')
  const lines: string[] = []
  const scanner = createConflictScanner({
    trashItem: async (path) => { renameSync(path, join(trash, basename(path))) },
    staysInside: pathStaysInside,
    onTrashed: (_scope, copy) => { lines.push(copy.name) },
  })
  const scan = await scanner.scanFolder({ scope: 'lib', folder, canonicalName: 'course.md' })
  expect(scan!.trashed).toEqual(['course (1).md'])
  expect(scan!.copies.map((c) => [c.name, c.state])).toEqual([['course-MacBook-Air.md', 'differs']])
  expect(lines).toEqual(['course (1).md'])
  expect(readdirSync(trash)).toEqual(['course (1).md'])
  expect(existsSync(join(folder, 'course.md'))).toBe(true)
  expect(existsSync(join(folder, 'course-notes.md'))).toBe(true)
})

test('machines: this Mac and machines seen are remembered per vault in app data', () => {
  const file = join(base, 'vault-machines.json')
  let asked = 0
  const m = createVaultMachines({ file, thisMac: () => { asked += 1; return ['kestrel.local', 'Dominik’s MacBook Air'] } })
  expect(asked).toBe(0)
  expect(m.known('v1')).toEqual(['kestrel', 'Dominiks-MacBook-Air'])
  m.remember('v1', ['DESKTOP-4F2K9', 'kestrel'])
  expect(createVaultMachines({ file, thisMac: [] }).known('v1')).toEqual(['kestrel', 'Dominiks-MacBook-Air', 'DESKTOP-4F2K9'])
  expect(asked).toBe(1)
})
