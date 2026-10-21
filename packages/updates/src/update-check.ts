import type { UpdateIdentity } from './options.ts'
import { compareVersions, validateFeed, type UpdateFeedLatest } from './update-feed.ts'
import {
  CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS, BUSY_RETRY_MS,
  availableMark, noteLaunch, whatsNewMark,
  type CopySource, type UpdateState, type WhatsNewMark,
} from './update-check-status.ts'

export type FeedAnswer = { ok: true; text: string } | { ok: false; reason: 'unreachable' | 'unreadable' | 'too-large' }

/** What the windows are told: the facts, and the two marks already decided. */
export interface UpdateSnapshot {
  identity: UpdateIdentity
  running: string
  platform: string
  arch?: string
  source: CopySource
  /** The setting `updates.checkForNewVersions`. */
  enabled: boolean
  checking: boolean
  state: UpdateState
  /** The status-bar mark for a newer version, or null (also null while busy). */
  mark: UpdateFeedLatest | null
  /** The Updated mark, or null. */
  whatsNew: WhatsNewMark | null
  /** A protected task is active: windows close any open notice. */
  busy: boolean
  /** A Check for Updates… was asked for while busy; it runs when busy ends. */
  waiting: boolean
}

export interface UpdateCheckerDeps {
  identity: UpdateIdentity
  running: string
  platform: string
  arch?: string
  source: CopySource
  /** One GET of the feed (update-check-electron.ts). Never called for a store copy or a development run. */
  fetchFeed(): Promise<FeedAnswer>
  readState(): UpdateState
  writeState(state: UpdateState): void
  /** The setting `updates.checkForNewVersions` (default on). */
  enabled(): boolean
  /** A protected task is active. */
  isBusy(): boolean
  /** Whether this version's What's new notes ship with the app. */
  hasNotes(version: string): boolean
  /** Whether configuration existed before this version was adopted (an upgrade, not a first install). */
  hadConfiguration(): boolean
  now(): number
  /** Tell the windows. */
  changed(snapshot: UpdateSnapshot): void
  /** A Check for Updates… that waited for the end of a protected task has finished: show the answer in the main window. */
  answered?(snapshot: UpdateSnapshot): void
  schedule?: typeof setTimeout
  cancel?: typeof clearTimeout
}

export function createUpdateChecker(deps: UpdateCheckerDeps) {
  const schedule = deps.schedule ?? setTimeout
  const cancel = deps.cancel ?? clearTimeout
  const mayCheck = deps.source === 'website' || deps.source === 'preview'
  let timer: ReturnType<typeof setTimeout> | null = null
  let running: Promise<UpdateSnapshot> | null = null
  let stopped = false
  /** A manual check waiting for busy to end. */
  let waiting = false
  let lastBusy = false

  function snapshot(): UpdateSnapshot {
    const state = deps.readState()
    const enabled = deps.enabled()
    const now = deps.now()
    const busy = deps.isBusy()
    const whatsNew = whatsNewMark(state, deps.running)
    return {
      identity: deps.identity, running: deps.running, platform: deps.platform, arch: deps.arch ?? (typeof process !== 'undefined' ? process.arch : undefined), source: deps.source, enabled, checking: running !== null, state,
      mark: busy ? null : availableMark(state, { running: deps.running, source: deps.source, enabled, now }),
      whatsNew: whatsNew && deps.hasNotes(whatsNew.version) ? whatsNew : null,
      busy, waiting,
    }
  }
  const tell = (): UpdateSnapshot => { const s = snapshot(); try { deps.changed(s) } catch { /* a closing window */ } return s }
  const patch = (next: Partial<UpdateState>): void => deps.writeState({ ...deps.readState(), ...next })

  /** The one request. Writes only the stored state. */
  function run(): Promise<UpdateSnapshot> {
    if (!mayCheck) return Promise.resolve(snapshot())
    if (running) return running
    let complete!: (snapshot: UpdateSnapshot) => void
    const pending = new Promise<UpdateSnapshot>((resolve) => { complete = resolve })
    running = pending
    void (async () => {
      tell()
      // A subscriber can enter protected mode while reacting to the checking state.
      if (deps.isBusy()) {
        waiting = true
        running = null
        arm(BUSY_RETRY_MS)
        complete(tell())
        return
      }
      let outcome: Partial<UpdateState>
      try {
        const answer = await deps.fetchFeed()
        if (!answer.ok) outcome = { lastResult: answer.reason === 'unreachable' ? 'unreachable' : 'unreadable' }
        else {
          const feed = validateFeed(answer.text, deps.identity.feedUrl)
          if (!feed.ok) outcome = { lastResult: 'unreadable' }
          else {
            // A fresh answer ends "Not now": the next check is the moment it was waiting for.
            outcome = {
              lastCheckAt: deps.now(), latest: feed.latest, snoozedUntil: undefined,
              lastResult: compareVersions(feed.latest.version, deps.running) > 0 ? 'newer' : 'current',
            }
          }
        }
      } catch {
        outcome = { lastResult: 'unreachable' }
      }
      try { patch(outcome) } catch { /* the state could not be written; the answer is lost, nothing else */ }
      running = null
      complete(tell())
    })()
    return pending
  }

  function arm(ms: number): void {
    if (timer !== null) cancel(timer)
    timer = stopped ? null : schedule(() => { timer = null; void tick() }, Math.max(1000, ms))
  }

  async function tick(): Promise<void> {
    if (stopped) return
    if (waiting) {
      if (deps.isBusy()) { arm(BUSY_RETRY_MS); return }
      waiting = false
      const done = await run()
      try { deps.answered?.(done) } catch { /* a closing window */ }
      arm(CHECK_INTERVAL_MS)
      return
    }
    if (!deps.enabled()) { arm(CHECK_INTERVAL_MS); return }
    if (deps.isBusy()) { arm(BUSY_RETRY_MS); return }
    const last = deps.readState().lastCheckAt
    const sinceLast = last === undefined ? Infinity : deps.now() - last
    if (sinceLast < CHECK_INTERVAL_MS && sinceLast >= 0) { arm(CHECK_INTERVAL_MS - sinceLast); return }
    await run()
    arm(CHECK_INTERVAL_MS)
  }

  return {
    snapshot,
    /** At launch: record the version run (and start What's new), then wait for the first check. */
    start(): UpdateSnapshot {
      try {
        const state = deps.readState()
        const next = noteLaunch(state, deps.running, deps.now(), deps.hadConfiguration())
        if (next !== state) deps.writeState(next)
      } catch { /* an unwritable config: nothing is shown that was not */ }
      if (mayCheck) arm(FIRST_CHECK_DELAY_MS)
      return tell()
    },
    stop(): void { stopped = true; if (timer !== null) cancel(timer); timer = null },
    /** Check for Updates…: always checks (a copy that may check), whatever the setting says. */
    checkNow(): Promise<UpdateSnapshot> {
      if (!mayCheck) return Promise.resolve(snapshot())
      // No request while busy: the asking waits, and its answer is shown when the app is no longer busy.
      if (deps.isBusy() && !running) {
        waiting = true
        arm(BUSY_RETRY_MS)
        return Promise.resolve(tell())
      }
      return run()
    },
    /** A protected task opened or closed: tell the windows, and run a check that waited. */
    busyChanged(): void {
      const now = deps.isBusy()
      if (now !== lastBusy) { lastBusy = now; tell() }
      if (!now && waiting && !stopped) { if (timer !== null) cancel(timer); timer = null; void tick() }
    },
    /** The setting changed: switching it on checks soon if a check is due. */
    settingChanged(): UpdateSnapshot {
      if (mayCheck && deps.enabled()) arm(FIRST_CHECK_DELAY_MS)
      return tell()
    },
    /** Skip this version: never mark this exact version again. */
    skip(version: string): UpdateSnapshot { patch({ skippedVersion: version }); return tell() },
    stopSkipping(): UpdateSnapshot { patch({ skippedVersion: undefined }); return tell() },
    /** Not now: no mark until the next daily check. */
    notNow(): UpdateSnapshot { patch({ snoozedUntil: deps.now() + CHECK_INTERVAL_MS }); return tell() },
    /** The Updated mark was clicked. */
    dismissWhatsNew(): UpdateSnapshot {
      const state = deps.readState()
      if (state.whatsNew) patch({ whatsNew: { ...state.whatsNew, dismissed: true } })
      return tell()
    },
  }
}

export type UpdateChecker = ReturnType<typeof createUpdateChecker>
