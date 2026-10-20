import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, Sparkles, ArrowUpCircle } from 'lucide-react'
import { dateText, versionLabel, availableMarkText, updatedMarkText, answerView, POPOVER_FOOTER, type AnswerView } from '@app-patterns/updates'
import { useUpdates, viewContext, answerOf, openLocalNotes } from './context.tsx'
export function UpdateStatusMark() {
  const { snapshot: snap, actions: api } = useUpdates()
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLSpanElement | null>(null)
  const popover = useRef<HTMLDivElement | null>(null)
  // Where the popover sits: just above the mark. It is drawn on the page itself (a portal, fixed), because the
  // status bar's left side clips whatever overflows it.
  const [place, setPlace] = useState<{ left: number; bottom: number } | null>(null)
  useEffect(() => {
    if (!open) return
    const rect = anchor.current?.getBoundingClientRect()
    if (rect) setPlace({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 400)), bottom: window.innerHeight - rect.top + 8 })
    const away = (event: MouseEvent): void => {
      const target = event.target as Node
      if (!anchor.current?.contains(target) && !popover.current?.contains(target)) setOpen(false)
    }
    const esc = (event: KeyboardEvent): void => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc) }
  }, [open])
  useEffect(() => { if (!snap?.mark || snap.busy) setOpen(false) }, [snap?.mark, snap?.busy])
  if (snap.busy || snap.source === 'store' || snap.source === 'development' || !snap.mark) return null
  const latest = snap.mark
  return (
    <>
      {latest && (
        <>
          <span style={{ margin: '0 8px', color: 'var(--app-updates-line, #d9d0c1)' }}>|</span>
          <span className="apu-update-anchor" ref={anchor}>
            <button type="button" className="apu-update-mark" data-update-mark aria-expanded={open} title={`A new version of ${snap.identity.appName} is out`} onClick={() => setOpen((v) => !v)}>
              <ArrowUpCircle size={11} aria-hidden /> {availableMarkText(latest)}
            </button>
            {open && place && !snap.busy && createPortal(
              <div className="apu-update-pop" ref={popover} style={{ position: 'fixed', left: place.left, bottom: place.bottom }} role="dialog" aria-label="A new version is available" data-update-popover>
                <h3>{snap.identity.appName} {latest.version} is available</h3>
                <div className="apu-update-sub">You have {versionLabel(snap.running)}. Released {dateText(latest.released)}.</div>
                <ul>{latest.summary.map((line, i) => <li key={i}>{line}</li>)}</ul>
                <div className="apu-update-actions">
                  <button type="button" className="apu-update-btn apu-update-btn--primary" data-update-download onClick={() => { void api.download(); setOpen(false) }}>
                    <Download size={13} aria-hidden /> Download from {new URL(snap.identity.feedUrl).host}
                  </button>
                  <button type="button" className="apu-update-btn" data-update-not-now onClick={() => { void api.notNow(); setOpen(false) }}>Not now</button>
                  <button type="button" className="apu-update-btn apu-update-btn--quiet" data-update-skip onClick={() => { void api.skip(latest.version); setOpen(false) }}>Skip this version</button>
                </div>
                <div className="apu-update-foot">
                  {POPOVER_FOOTER}{' '}
                  <button type="button" className="apu-update-link" data-update-notes onClick={() => void api.openNotes(latest.version)}>What&rsquo;s new in {latest.version}</button>
                </div>
              </div>,
              document.body
            )}
          </span>
        </>
      )}

    </>
  )
}


/** A local-note mark; clicking is the only operation that opens notes. */
export function WhatsNewMark() {
  const { snapshot, actions } = useUpdates()
  if (!snapshot.whatsNew || snapshot.busy) return null
  return <button type="button" className="apu-update-mark apu-update-mark--updated" data-whats-new-mark onClick={() => {
    void actions.dismissWhatsNew()
    void openLocalNotes(snapshot, actions)
  }}><Sparkles size={11} aria-hidden /> {updatedMarkText(snapshot.whatsNew)}</button>
}

export function UpdateMarks() { return <><UpdateStatusMark /><WhatsNewMark /></> }

export function AnswerButtons({ view, onDone, onView, size }: { view: AnswerView; onDone?: () => void; onView?: (next: AnswerView) => void; size?: 'card' }) {
  const { actions: api, snapshot } = useUpdates()
  if (!api || view.action === null) return null
  const cls = (primary: boolean): string => `apu-update-btn${primary ? ' apu-update-btn--primary' : ''}`
  const again = async (): Promise<void> => {
    const snap = await api.check()
    onView?.(answerOf(snap))
  }
  return (
    <div className="apu-update-actions">
      {view.action === 'download' && <button type="button" className={cls(true)} data-update-download onClick={() => { void api.download(); onDone?.() }}><Download size={13} aria-hidden /> {size === 'card' ? 'Download…' : `Download from ${new URL(snapshot.identity.feedUrl).host}`}</button>}
      {view.action === 'stop-skipping' && <button type="button" className={cls(false)} data-update-stop-skipping onClick={() => { void api.stopSkipping().then(() => onView?.(answerView({ ...snapshot.state, skippedVersion: undefined }, viewContext(snapshot)))) }}>Stop skipping</button>}
      {view.action === 'try-again' && <button type="button" className={cls(false)} data-update-try-again onClick={() => void again()}>Try again</button>}
      {view.action === 'open-store' && <button type="button" className={cls(false)} data-update-open-store onClick={() => { void api.openStore(); onDone?.() }}>Open in {snapshot.identity.storeName ?? 'app store'}</button>}
      {view.action === 'check' && <button type="button" className={cls(false)} data-update-check onClick={() => void again()}>Check for updates</button>}
      {view.whatsNew && view.version && <button type="button" className="apu-update-link" data-update-notes onClick={() => void api.openNotes(view.version as string)}>What&rsquo;s new in {view.version}</button>}
    </div>
  )
}
