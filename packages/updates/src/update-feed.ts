import type { UpdateIdentity } from './options.ts'

export const MAX_FEED_BYTES = 64 * 1024
export const MAX_SUMMARY_LINES = 3
export const MAX_SUMMARY_LINE_LENGTH = 120

export interface UpdateFeedLatest {
  version: string
  /** A calendar date, `YYYY-MM-DD`. */
  released: string
  summary: string[]
  notes: string
  download: { mac: string; windows: string }
}

export type FeedRejection = 'too-large' | 'not-json' | 'not-a-version-list'
export type FeedResult = { ok: true; latest: UpdateFeedLatest } | { ok: false; reason: FeedRejection }

// ── Versions ────────────────────────────────────────────────────────────────────────────────────

export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  /** The pre-release part (`preview.3` → ['preview', 3]); empty for a release. */
  pre: Array<string | number>
}

const VERSION_SHAPE = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*))?$/

/** Reads `1.2.3` or `1.2.3-preview.4`; null for anything else. */
export function parseVersion(text: unknown): ParsedVersion | null {
  if (typeof text !== 'string') return null
  const match = VERSION_SHAPE.exec(text)
  if (!match) return null
  const pre = match[4] === undefined ? [] : match[4].split('.').map((part) => (/^\d+$/.test(part) ? Number(part) : part))
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre }
}

/** A plain release number: no pre-release part. */
export function isReleaseNumber(text: unknown): text is string {
  const parsed = parseVersion(text)
  return parsed !== null && parsed.pre.length === 0
}

/** Semantic-version order. A pre-release is older than its own release (`0.42.0-preview.3` < `0.42.0`). */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return 0
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0
  if (left.pre.length === 0) return 1
  if (right.pre.length === 0) return -1
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i += 1) {
    const x = left.pre[i]
    const y = right.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1
    if (typeof x === 'number') return -1
    if (typeof y === 'number') return 1
    return x < y ? -1 : 1
  }
  return 0
}

/** `0.42.0-preview.3` → `0.42.0, preview 3` (as About and updates writes it); a release is unchanged. */
export function versionLabel(version: string): string {
  const parsed = parseVersion(version)
  if (!parsed || parsed.pre.length === 0) return version
  const base = `${parsed.major}.${parsed.minor}.${parsed.patch}`
  const [name, number] = parsed.pre
  return typeof number === 'number' ? `${base}, ${name} ${number}` : `${base}, ${parsed.pre.join(' ')}`
}

export const isPreviewVersion = (version: string): boolean => (parseVersion(version)?.pre.length ?? 0) > 0

// ── Links ───────────────────────────────────────────────────────────────────────────────────────

/** An https link on the app’s own site, with no credentials or port, no spaces or control characters. */
export function isSiteLink(link: unknown, feedUrl: string): link is string {
  let prefix: string
  try { prefix = feedOrigin(feedUrl) + '/' } catch { return false }
  if (typeof link !== 'string' || link.length > 300 || !link.startsWith(prefix)) return false
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f\\]/.test(link)) return false
  let url: URL
  try { url = new URL(link) } catch { return false }
  if (url.protocol !== 'https:' || url.origin !== feedOrigin(feedUrl)) return false
  if (url.username !== '' || url.password !== '' || url.port !== '') return false
  return true
}

// ── The file ────────────────────────────────────────────────────────────────────────────────────

function isCalendarDate(text: unknown): text is string {
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return false
  const parsed = new Date(`${text}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text
}

function isSummaryLine(line: unknown): line is string {
  // Text only: no markup characters and no control characters.
  // eslint-disable-next-line no-control-regex
  return typeof line === 'string' && line.trim().length > 0 && line.length <= MAX_SUMMARY_LINE_LENGTH && !/[<>\u0000-\u001f\u007f]/.test(line)
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Validates the parsed feed. Returns the one entry it carries, or null when anything is wrong. */
export function validateFeedObject(value: unknown, feedUrl: string): UpdateFeedLatest | null {
  if (!isRecord(value) || value.schema !== 1 || !isRecord(value.latest)) return null
  const latest = value.latest
  const { version, released, summary, notes, download } = latest
  if (!isReleaseNumber(version) || !isCalendarDate(released)) return null
  if (!Array.isArray(summary) || summary.length < 1 || summary.length > MAX_SUMMARY_LINES || !summary.every(isSummaryLine)) return null
  if (!isSiteLink(notes, feedUrl) || !isRecord(download) || !isSiteLink(download.mac, feedUrl) || !isSiteLink(download.windows, feedUrl)) return null
  return { version, released, summary: [...summary], notes, download: { mac: download.mac, windows: download.windows } }
}

/** Validates the text of an answer: size, JSON, then shape. */
export function validateFeed(text: unknown, feedUrl: string): FeedResult {
  if (typeof text !== 'string') return { ok: false, reason: 'not-json' }
  if (utf8Length(text) > MAX_FEED_BYTES) return { ok: false, reason: 'too-large' }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { return { ok: false, reason: 'not-json' } }
  const latest = validateFeedObject(parsed, feedUrl)
  return latest ? { ok: true, latest } : { ok: false, reason: 'not-a-version-list' }
}

/** UTF-8 length without Buffer (this file also runs in the renderer's bundle). */
function utf8Length(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; i += 1 }
    else bytes += 3
  }
  return bytes
}

/** The download link for a platform (`process.platform`); the download page when there is none. */
export function downloadLinkFor(latest: UpdateFeedLatest, platform: string, feedUrl: string): string {
  if (platform === 'darwin') return latest.download.mac
  if (platform === 'win32') return latest.download.windows
  return new URL('/download', feedUrl).href
}

// ── The request ─────────────────────────────────────────────────────────────────────────────────

/**
 * The whole request, in one place so a test can read what is sent: a GET to the feed address with a
 * fixed User-Agent. No query string, no version, no identifier, no cookie, no credentials. A redirect
 * is an error, never followed.
 */
export function feedOrigin(feedUrl: string): string {
  const url = new URL(feedUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || /[\s\\]/.test(feedUrl)) throw new Error('The feed must be an HTTPS URL without credentials, port, query or fragment.')
  return url.origin
}

export function feedRequest(options: UpdateIdentity) {
  feedOrigin(options.feedUrl)
  if (!options.appName.trim() || /[\r\n]/.test(options.appName)) throw new Error('A fixed app name is required.')
  return {
    url: options.feedUrl, method: 'GET' as const,
    headers: { 'User-Agent': options.appName, Accept: 'application/json' },
    timeoutMs: 10_000, maxBytes: MAX_FEED_BYTES
  }
}
