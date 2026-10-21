import type { UpdateIdentity } from './options.ts'
import {
  compareVersions, isPreviewVersion, parseVersion, validateFeedObject, versionLabel,
  type UpdateFeedLatest,
} from './update-feed.ts'

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
/** The first check runs this long after launch, not during start-up. */
export const FIRST_CHECK_DELAY_MS = 2 * 60 * 1000
/** A check that fell due while busy waits, and looks again this often. */
export const BUSY_RETRY_MS = 20 * 1000
/** What's new goes after this many days on which the app was opened. */
export const WHATS_NEW_DAYS = 7
export const SETTING_KEY = 'updates.checkForNewVersions'

export type CheckOutcome = 'current' | 'newer' | 'unreachable' | 'unreadable'
/** Where this copy came from: the website, an app store, a preview build, or a development run. */
export type CopySource = 'website' | 'store' | 'preview' | 'development'

/** Persisted update state, separate from settings. */
export interface UpdateState {
  /** The last SUCCESSFUL check (an answer that was a version list), ms since the epoch. */
  lastCheckAt?: number
  /** What the last attempt found. */
  lastResult?: CheckOutcome
  /** The newest version the last successful check read. */
  latest?: UpdateFeedLatest
  skippedVersion?: string
  /** "Not now": no mark until this time. */
  snoozedUntil?: number
  /** The version that last ran on this computer. */
  lastVersionRun?: string
  /** The Updated mark: which version, from which, and the days on which the app was opened since. */
  whatsNew?: { version: string; from: string | null; days: string[]; dismissed?: boolean }
}

const isMs = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const isOutcome = (value: unknown): value is CheckOutcome => value === 'current' || value === 'newer' || value === 'unreachable' || value === 'unreadable'

/** Reads the stored state tolerantly: anything of the wrong shape is dropped, the feed entry is validated again. */
export function readUpdateState(raw: unknown, feedUrl: string): UpdateState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const r = raw as Record<string, unknown>
  const state: UpdateState = {}
  if (isMs(r.lastCheckAt)) state.lastCheckAt = r.lastCheckAt
  if (isOutcome(r.lastResult)) state.lastResult = r.lastResult
  const latest = validateFeedObject({ schema: 1, latest: r.latest }, feedUrl)
  if (latest) state.latest = latest
  if (typeof r.skippedVersion === 'string' && parseVersion(r.skippedVersion)) state.skippedVersion = r.skippedVersion
  if (isMs(r.snoozedUntil)) state.snoozedUntil = r.snoozedUntil
  if (typeof r.lastVersionRun === 'string' && parseVersion(r.lastVersionRun)) state.lastVersionRun = r.lastVersionRun
  const w = r.whatsNew
  if (typeof w === 'object' && w !== null && !Array.isArray(w)) {
    const wn = w as Record<string, unknown>
    if (typeof wn.version === 'string' && parseVersion(wn.version)) {
      state.whatsNew = {
        version: wn.version,
        from: typeof wn.from === 'string' && parseVersion(wn.from) ? wn.from : null,
        days: Array.isArray(wn.days) ? wn.days.filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(-14) : [],
        ...(wn.dismissed === true ? { dismissed: true } : {}),
      }
    }
  }
  return state
}

// ── The mark in the status bar ──────────────────────────────────────────────────────────────────

export interface MarkContext { running: string; source: CopySource; enabled: boolean; now: number }

/** Is a newer version than the one running known? */
export const isNewer = (latest: UpdateFeedLatest | undefined, running: string): latest is UpdateFeedLatest =>
  !!latest && compareVersions(latest.version, running) > 0

/**
 * The version the status-bar mark offers, or null. Nothing for a Store copy or a development run, with
 * daily checking off, for a skipped version, or while "Not now" holds.
 */
export function availableMark(state: UpdateState, ctx: MarkContext): UpdateFeedLatest | null {
  if (ctx.source === 'store' || ctx.source === 'development' || !ctx.enabled) return null
  if (!isNewer(state.latest, ctx.running)) return null
  if (state.skippedVersion === state.latest.version) return null
  if (state.snoozedUntil !== undefined && ctx.now < state.snoozedUntil) return null
  return state.latest
}

// ── What's new ──────────────────────────────────────────────────────────────────────────────────

/** `YYYY-MM-DD` in local time. */
export function localDay(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Called once at each launch. Returns the patch to store. An update (a newer version than the last one
 * run here) starts the Updated mark; a first install does not (no last version run and no configuration yet);
 * a configuration that already holds configuration but has no last version run is an upgrade from a version
 * that recorded none, so it counts; a downgrade clears the mark. The same version run again counts one
 * more day of use.
 */
export function noteLaunch(state: UpdateState, running: string, now: number, hadConfiguration: boolean): UpdateState {
  const today = localDay(now)
  const last = state.lastVersionRun
  if (last === undefined) {
    return hadConfiguration
      ? { ...state, lastVersionRun: running, whatsNew: { version: running, from: null, days: [today] } }
      : { ...state, lastVersionRun: running, whatsNew: undefined }
  }
  const order = compareVersions(running, last)
  if (order > 0) return { ...state, lastVersionRun: running, whatsNew: { version: running, from: last, days: [today] } }
  if (order < 0) return { ...state, lastVersionRun: running, whatsNew: undefined }
  const mark = state.whatsNew
  if (!mark || mark.version !== running) return state
  return mark.days.includes(today) ? state : { ...state, whatsNew: { ...mark, days: [...mark.days, today] } }
}

export interface WhatsNewMark { version: string; from: string | null }

/** The "Updated to <version> · What's new" mark: until it is clicked or seven days of use pass. */
export function whatsNewMark(state: UpdateState, running: string): WhatsNewMark | null {
  const mark = state.whatsNew
  if (!mark || mark.dismissed || mark.version !== running) return null
  if (mark.days.length > WHATS_NEW_DAYS) return null
  return { version: mark.version, from: mark.from }
}

// ── When ────────────────────────────────────────────────────────────────────────────────────────

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const clock = (d: Date): string => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

/** "today at 09:12", "yesterday at 18:40", "Monday at 09:05", "3 October 2026 at 09:05" (local time). */
export function whenText(at: number, now: number): string {
  const d = new Date(at)
  const today = new Date(now)
  const startOf = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((startOf(today) - startOf(d)) / 86_400_000)
  if (days === 0) return `today at ${clock(d)}`
  if (days === 1) return `yesterday at ${clock(d)}`
  if (days > 1 && days < 7) return `${WEEKDAYS[d.getDay()]} at ${clock(d)}`
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} at ${clock(d)}`
}

/** "12 November 2026" from `YYYY-MM-DD`. */
export function dateText(day: string): string {
  const [y = 0, m = 1, d = 1] = day.split('-').map(Number)
  return `${d} ${MONTHS[m - 1]} ${y}`
}

const lastChecked = (state: UpdateState, now: number): string | null => {
  if (state.lastCheckAt === undefined) return null
  return now - state.lastCheckAt < 60_000 ? 'Checked just now.' : `Last checked ${whenText(state.lastCheckAt, now)}.`
}

// ── The copy ────────────────────────────────────────────────────────────────────────────────────

export interface CopyFacts { identity: UpdateIdentity; running: string; platform: string; arch?: string; source: CopySource }

const PLATFORM_NAMES: Record<string, string> = { win32: 'Windows' }

/** "Version 0.41.0" and the line under it (frames 03 and 06). */
export function aboutLines(facts: CopyFacts): { version: string; where: string } {
  const platform = facts.platform === 'darwin' ? (facts.arch === 'arm64' ? 'Mac (Apple silicon)' : facts.arch === 'x64' ? 'Mac (Intel)' : 'Mac') : PLATFORM_NAMES[facts.platform] ?? facts.platform
  const where = facts.source === 'store' ? 'installed from the ' + (facts.identity.storeName ?? 'app store')
    : facts.source === 'preview' ? 'preview built for testing'
    : facts.source === 'development' ? 'development run'
    : 'downloaded from ' + new URL(facts.identity.feedUrl).host
  return { version: `Version ${versionLabel(facts.running)}`, where: `${platform} · ${where}` }
}

export function copySource(input: { packaged: boolean; store: boolean; running: string }): CopySource {
  if (input.store) return 'store'
  if (!input.packaged) return 'development'
  return isPreviewVersion(input.running) ? 'preview' : 'website'
}

// ── What each surface says ──────────────────────────────────────────────────────────────────────

export type AnswerTone = 'good' | 'new' | 'warn' | 'store' | 'plain'
export type AnswerAction = 'download' | 'try-again' | 'stop-skipping' | 'open-store' | 'check'

export interface AnswerView {
  tone: AnswerTone
  title: string
  detail: string
  /** The button the answer offers, if any. */
  action: AnswerAction | null
  /** The version a new-version answer is about (for Download and What's new in <version>). */
  version?: string
  /** Offer "What's new in <version>". */
  whatsNew?: boolean
}

export interface ViewContext extends CopyFacts { enabled: boolean; checking: boolean; now: number }

/**
 * What a deliberate Check for Updates… says once it has finished (frames 09 and 11): up to date, a new
 * version (a skipped version is offered too, with Stop skipping), could not check, or the Store's answer.
 */
export function answerView(state: UpdateState, ctx: ViewContext): AnswerView {
  if (ctx.source === 'store') {
    return { tone: 'store', title: `Updates come from the ${ctx.identity.storeName ?? 'app store'}.`, detail: `The Store installs new versions of ${ctx.identity.appName}. This copy does not check ${new URL(ctx.identity.feedUrl).host}.`, action: 'open-store' }
  }
  if (ctx.source === 'development') {
    return { tone: 'plain', title: 'This copy does not check for updates.', detail: `Only the installed ${ctx.identity.appName} checks ${new URL(ctx.identity.feedUrl).host}.`, action: null }
  }
  if (state.lastResult === 'unreachable' || state.lastResult === 'unreadable') {
    const last = state.lastCheckAt === undefined ? `${ctx.identity.appName} has not checked successfully yet.` : `Last successful check: ${whenText(state.lastCheckAt, ctx.now)}.`
    const why = state.lastResult === 'unreachable'
      ? `${new URL(ctx.identity.feedUrl).host} could not be reached. This computer may be offline.`
      : `${new URL(ctx.identity.feedUrl).host} answered, but not with a version list.`
    return { tone: 'warn', title: 'Could not check for updates.', detail: `${why} ${last}`, action: 'try-again' }
  }
  if (isNewer(state.latest, ctx.running)) {
    const skipped = state.skippedVersion === state.latest.version
    return {
      tone: 'new', title: `${ctx.identity.appName} ${state.latest.version} is available.`, detail: `You have ${versionLabel(ctx.running)}.`,
      action: skipped ? 'stop-skipping' : 'download', version: state.latest.version, whatsNew: true,
    }
  }
  return {
    tone: 'good', title: 'You have the newest version.',
    detail: `${ctx.identity.appName} ${versionLabel(ctx.running)} is the latest. ${lastChecked(state, ctx.now) ?? ''}`.trim(), action: null,
  }
}

/**
 * The state of the New versions card in Settings (frames 03, 04 and 06): what it says now, whatever the
 * last check or the setting left it in. `null` for a Store copy, which has no card.
 */
export function cardView(state: UpdateState, ctx: ViewContext): AnswerView | null {
  if (ctx.source === 'store') return null
  const since = lastChecked(state, ctx.now)
  if (ctx.source === 'development') {
    return { tone: 'plain', title: 'This copy does not check for new versions.', detail: `Only the installed ${ctx.identity.appName} checks ${new URL(ctx.identity.feedUrl).host}.`, action: null }
  }
  if (ctx.checking) return { tone: 'plain', title: `Checking ${new URL(ctx.identity.feedUrl).host}…`, detail: since ?? '', action: null }
  // Shared update-notice state and wording.
  if (!ctx.enabled) return { tone: 'plain', title: `${ctx.identity.appName} does not check for new versions.`, detail: 'Check for updates still checks once.', action: 'check' }
  if (state.lastResult === 'unreachable') {
    const last = state.lastCheckAt === undefined ? '' : ` Last successful check: ${whenText(state.lastCheckAt, ctx.now)}.`
    return { tone: 'warn', title: `Could not reach ${new URL(ctx.identity.feedUrl).host}.`, detail: `This computer may be offline. ${ctx.identity.appName} will try again tomorrow.${last}`, action: 'try-again' }
  }
  if (state.lastResult === 'unreadable') {
    return { tone: 'warn', title: `${new URL(ctx.identity.feedUrl).host} answered, but not with a version list.`, detail: `Nothing was changed. ${ctx.identity.appName} will try again tomorrow.`, action: 'try-again' }
  }
  if (isNewer(state.latest, ctx.running)) {
    if (state.skippedVersion === state.latest.version) {
      return { tone: 'plain', title: `You skipped ${state.latest.version}.`, detail: 'You will hear about the next version after it.', action: 'stop-skipping', version: state.latest.version }
    }
    return { tone: 'new', title: `${ctx.identity.appName} ${state.latest.version} is available. You have ${versionLabel(ctx.running)}.`, detail: since ?? '', action: 'download', version: state.latest.version }
  }
  if (state.lastCheckAt === undefined) return { tone: 'plain', title: 'Not checked yet.', detail: `${ctx.identity.appName} checks a couple of minutes after it starts.`, action: 'check' }
  return { tone: 'good', title: 'You have the newest version.', detail: since ?? '', action: 'check' }
}

/** The status-bar mark's text (frame 01). */
export const availableMarkText = (latest: UpdateFeedLatest): string => `${latest.version} is available`
/** The Updated mark's text (frame 08). */
export const updatedMarkText = (mark: WhatsNewMark): string => `Updated to ${mark.version} · What's new`

export function privacyText(identity: UpdateIdentity): string {
  const site = new URL(identity.feedUrl)
  return `${identity.appName} reads one file, ${site.host}${site.pathname}, and compares versions on this computer. It sends nothing about you, your documents or your version. Like any website, ${site.host} sees this computer’s internet address.`
}
export const storeAboutLine = (identity: UpdateIdentity): string =>
  `The ${identity.storeName ?? 'app store'} installs new versions of ${identity.appName}.`
export const storeAboutDetail = 'This copy does not check for new versions itself. To see or change how the store updates apps, open the store’s settings.'
export const SETTING_HINT = 'Once a day. Check for updates checks at any time.'

/** The popover's footer under the three buttons (frame 02). */
export const POPOVER_FOOTER = 'Download opens the download page in your browser. Install it as you installed this one; your documents and settings stay as they are.'

// ── What's new notes ────────────────────────────────────────────────────────────────────────────

export interface WhatsNewItem { title: string | null; text: string }

/**
 * The notes file for a version (`resources/whats-new/<version>.md`): bullet lines, each a plain
 * sentence, optionally starting with a bold title (`- **Full-screen task.** The next two steps show.`).
 * Anything else (headings, blank lines) is ignored; the text is kept as text.
 */
export function parseWhatsNew(markdown: string): WhatsNewItem[] {
  const items: WhatsNewItem[] = []
  for (const raw of markdown.split(/\r?\n/)) {
    const match = /^\s*[-*]\s+(.*\S)\s*$/.exec(raw)
    if (!match) continue
    const body = match[1]!
    const titled = /^\*\*(.+?)\*\*[:.]?\s*(.*)$/.exec(body)
    if (titled && titled[2]) items.push({ title: titled[1]!.replace(/[.:]$/, ''), text: titled[2] })
    else items.push({ title: null, text: body.replace(/\*\*/g, '') })
  }
  return items.slice(0, 12)
}

// ── The note and busy state ─────────────────────────────────────────────────────────────────────

/** What the answer note shows and what it holds back. While the app reports itself busy nothing is shown. */
export interface NoteState<V> { shown: V | null; held: V | null }
export type NoteEvent<V> =
  | { kind: 'answer'; view: V | null; busy: boolean }
  | { kind: 'busy'; busy: boolean }
  | { kind: 'dismiss' }

/**
 * An answer that arrives while busy is held and shown when busy ends; a busy period that starts
 * clears the note on screen (keeping nothing of it). Nothing is ever shown while busy.
 */
export function noteReducer<V>(state: NoteState<V>, event: NoteEvent<V>): NoteState<V> {
  if (event.kind === 'dismiss') return { shown: null, held: null }
  if (event.kind === 'answer') return event.busy ? { shown: null, held: event.view } : { shown: event.view, held: null }
  return event.busy ? { shown: null, held: state.held } : { shown: state.held ?? state.shown, held: null }
}
