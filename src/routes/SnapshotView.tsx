import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import type { InkwaveDocument, Snapshot } from '../types/document'
import { listSnapshots } from '../provenance/snapshots'
import { loadDocument } from '../storage/opfs'
import { pmToText } from '../provenance/bundle'
import { diffWords, diffStats } from '../provenance/diff'
import { Scroll, isTouchDevice } from '../editor/Scroll'
import { DocView } from '../components/DocView'

const INK = '#5c2d8a'
const LIGHT = '#9b5ccc'

// Read-only viewer for a single past snapshot, opened in a new tab from the record panel
// (?doc=<id>&snap=<id>). Shows that exact version as it was written, and can diff it against the
// current document. Everything reads from local OPFS — no network, no sign-in.
export function SnapshotView() {
  const [params] = useSearchParams()
  const docId = params.get('doc')
  const snapId = params.get('snap')

  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [current, setCurrent] = useState<InkwaveDocument | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing'>('loading')
  const [showDiff, setShowDiff] = useState(false)

  useEffect(() => {
    let cancelled = false
    if (!docId || !snapId) { setStatus('missing'); return }
    void (async () => {
      const [snaps, doc] = await Promise.all([listSnapshots(docId), loadDocument(docId)])
      if (cancelled) return
      const snap = snaps.find((s) => s.id === snapId) ?? null
      setSnapshot(snap)
      setCurrent(doc)
      setStatus(snap ? 'ready' : 'missing')
    })()
    return () => { cancelled = true }
  }, [docId, snapId])

  const ops = useMemo(() => {
    if (!snapshot || !current) return null
    return diffWords(pmToText(snapshot.contentJson), pmToText(current.contentJson))
  }, [snapshot, current])
  const stats = ops ? diffStats(ops) : null
  const isCurrent = stats ? stats.added === 0 && stats.removed === 0 : false

  return (
    <div className="min-h-screen font-serif" style={{ color: '#3a3a3a' }}>
      {/* Read-only banner */}
      <div className="sticky top-0 z-50 flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 bg-white/95 backdrop-blur text-sm"
        style={{ borderBottom: `1px solid ${INK}33` }}>
        <span style={{ color: INK }}>
          ◈ {snapshot ? `Snapshot from ${new Date(snapshot.createdAt).toLocaleString()}` : 'Snapshot'} · read-only
        </span>
        {snapshot && (
          <span className="text-stone-400 text-xs">{snapshot.wordCount} words · {snapshot.ots.status}</span>
        )}
        {status === 'ready' && current && (
          <label className="flex items-center gap-1.5 text-xs text-stone-500 cursor-pointer select-none ml-auto">
            <input type="checkbox" checked={showDiff} onChange={(e) => setShowDiff(e.target.checked)} className="accent-[#5c2d8a]" />
            Show changes since this version
          </label>
        )}
        <Link to="/" className="text-xs underline" style={{ color: LIGHT }}>← editor</Link>
      </div>

      {status === 'loading' && <p className="text-center text-stone-400 mt-20">Loading…</p>}
      {status === 'missing' && (
        <p className="text-center text-stone-500 mt-20">
          That snapshot isn’t on this device. Snapshots live in the browser where they were written.
        </p>
      )}

      {status === 'ready' && snapshot && (
        <Scroll phone={isTouchDevice()}>
          {showDiff && ops ? (
            <div>
              <p className="text-xs text-stone-400 mb-3">
                {isCurrent ? 'No changes — this matches the current document.' : (
                  <>changes from this snapshot → now: <span style={{ color: '#246b24' }}>+{stats!.added}</span>{' '}
                  <span style={{ color: '#9b2226' }}>−{stats!.removed}</span> words</>
                )}
              </p>
              <div className="tiptap-editor ProseMirror" style={{ whiteSpace: 'pre-wrap' }}>
                {ops.map((op, i) =>
                  op.type === 'same' ? <span key={i}>{op.text}</span>
                  : op.type === 'add' ? <span key={i} style={{ background: '#dcf5dc', color: '#1f5f1f' }}>{op.text}</span>
                  : <span key={i} style={{ color: '#9b2226', textDecoration: 'line-through' }}>{op.text}</span>,
                )}
              </div>
            </div>
          ) : (
            <div className="tiptap-editor ProseMirror">
              <DocView doc={snapshot.contentJson} />
            </div>
          )}
        </Scroll>
      )}
    </div>
  )
}
