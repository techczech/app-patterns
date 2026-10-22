import { useEffect, useState, type CSSProperties } from 'react'
import { SETTING_HINT, storeAboutDetail, storeAboutLine, privacyText, aboutLines, answerView, cardView } from '@app-patterns/updates'
import { useUpdates, viewContext, answerOf, openLocalNotes } from './context.tsx'
import { AnswerButtons } from './update-marks.tsx'
type Look = Record<'sectionHead' | 'hint' | 'rowFolder' | 'folderLabel' | 'btn', CSSProperties>

const card: CSSProperties = { border: '1px solid var(--app-updates-line, #d9d0c1)', borderRadius: 8, overflow: 'hidden', margin: '8px 0 10px', background: 'var(--app-updates-panel, #fffdf8)' }
const cardHead: CSSProperties = { padding: '7px 12px', fontSize: 12.5, fontWeight: 700, background: 'var(--app-updates-hover, #ede8dc)', borderBottom: '1px solid var(--app-updates-line, #d9d0c1)' }
const cardRow: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, padding: '9px 12px', borderTop: '1px solid var(--app-updates-line, #d9d0c1)' }
const sub: CSSProperties = { fontSize: 11.5, color: 'var(--app-updates-muted, #5d6875)', marginTop: 2, lineHeight: 1.4 }

export function AboutUpdatesCard() {
  const { snapshot: snap, actions: api } = useUpdates()
  const look: Look = { sectionHead: { display: 'none' }, hint: {}, rowFolder: {}, folderLabel: { fontWeight: 600 }, btn: { cursor: 'pointer' } }
  const onShowWhatsNew = (): void => { void openLocalNotes(snap, api) }
  const [asked, setAsked] = useState(false)
  const [hasNotes, setHasNotes] = useState(false)
  useEffect(() => {
    let live = true
    void api.loadNotes(snap.running).then((n) => { if (live) setHasNotes(n !== null) }).catch(() => {})
    return () => { live = false }
  }, [api, snap.running])
  if (!snap || !api) return null
  const ctx = viewContext(snap)
  const about = aboutLines(ctx)
  // The card always follows the latest snapshot: a check's answer arrives as one, so no older local answer can outlast a newer one.
  const view = snap.waiting || (asked && snap.busy)
    ? answerOf({ ...snap, waiting: true })
    : asked && !snap.checking ? answerView(snap.state, ctx) : cardView(snap.state, ctx)
  const flip = (): void => {
    setAsked(false)
    const was = snap.enabled
    void api.setEnabled(!was)
  }
  return (
    <div className="apu-updates">
      <div style={look.sectionHead} data-settings-section="about">About and updates</div>
      <div style={card} data-about-card>
        <div style={cardHead}>{snap.identity.appName}</div>
        <div style={{ ...cardRow, borderTop: 'none' }}>
          <div style={{ minWidth: 0 }}>
            <div style={look.folderLabel} data-about-version>{about.version}</div>
            <div style={sub} data-about-where>{about.where}</div>
          </div>
          {hasNotes && <button style={look.btn} data-about-whats-new onClick={onShowWhatsNew}>What&rsquo;s new in {snap.running}</button>}
        </div>
        {snap.source === 'store' && (
          <div style={cardRow} data-about-store>
            <div style={{ minWidth: 0 }}>
              <div style={look.folderLabel}>{storeAboutLine(snap.identity)}</div>
              <div style={sub}>{storeAboutDetail}</div>
            </div>
            <button style={look.btn} data-update-open-store onClick={() => void api.openStore()}>Open in {snap.identity.storeName ?? 'app store'}</button>
          </div>
        )}
      </div>
      {snap.source !== 'store' && (
        <div style={card} data-updates-card>
          <div style={cardHead}>New versions</div>
          <div style={{ ...cardRow, borderTop: 'none' }} data-setting="check-for-new-versions">
            <div style={{ minWidth: 0 }}>
              <div style={look.folderLabel}>Check for new versions</div>
              <div style={sub}>{SETTING_HINT}</div>
            </div>
            <button type="button" role="switch" aria-checked={snap.enabled} aria-label="Check for new versions" className="apu-update-switch" onClick={flip} />
          </div>
          {view && (
            <div style={cardRow} data-update-state={view.tone}>
              <div style={{ minWidth: 0 }}>
                <div className={`apu-update-state--${view.tone}`} style={{ fontSize: 12.5, fontWeight: 600 }}>{view.title}</div>
                {view.detail && <div style={sub}>{view.detail}</div>}
              </div>
              {snap.checking
                ? <button className="apu-update-btn" disabled>Check for updates</button>
                : (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <AnswerButtons view={view} size="card" onView={() => setAsked(true)} />
                    {view.action !== 'check' && view.action !== 'try-again' && (
                      <button type="button" className="apu-update-btn" data-update-check onClick={() => { void api.check().then(() => setAsked(true)) }}>Check for updates</button>
                    )}
                  </div>
                )}
            </div>
          )}
          <div style={cardRow}>
            <div style={{ minWidth: 0 }}>
              <div style={look.folderLabel}>What the check sends</div>
              <div style={sub} data-update-sends>{privacyText(snap.identity)}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
