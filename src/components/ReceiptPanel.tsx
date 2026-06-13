import { useEffect, useState } from 'react'
import type { Snapshot } from '../types/document'
import { useZoomScale } from '../editor/useZoomScale'

// The growing record of tamper-evident snapshots + the live-composition receipt chain the writer
// holds. Saving/syncing lives in the ⋮ menu (not duplicated here); this panel is the record viewer:
// verify the chain, nudge Bitcoin confirmation, and list the dated snapshots.
export function ReceiptPanel({
  snapshots,
  onCheckBitcoin,
  receiptCount = 0,
  chainStatus,
  onVerifyChain,
}: {
  snapshots: Snapshot[]
  onCheckBitcoin?: () => void
  receiptCount?: number
  chainStatus?: string | null
  onVerifyChain?: () => void
}) {
  const [open, setOpen] = useState(false)
  const zoom = useZoomScale()
  const n = snapshots.length
  const pending = snapshots.some((s) => s.ots.status === 'pending')

  // Close on Escape (outside-click is handled by the backdrop below).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const panelOpen = open && (n > 0 || receiptCount > 0)

  return (
    <>
      {/* Invisible backdrop catches any outside click reliably (a document listener was missing
          clicks on the page background). Below the panel (z-30 < z-40), above the rest. */}
      {panelOpen && <div className="fixed inset-0 z-30" aria-hidden="true" onMouseDown={() => setOpen(false)} />}

      {/* Anchored at the very corner with the inset as PADDING (inside the scaled box) so zoom
          compensation keeps both size AND position constant — no drift. */}
      <div
        className="fixed bottom-0 left-0 z-40 font-serif text-sm select-none"
        style={{ color: '#5c2d8a', padding: '1rem', transform: zoom !== 1 ? `scale(${zoom})` : undefined, transformOrigin: 'bottom left' }}
      >
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="px-2.5 py-1 bg-white"
          style={{ border: '1px solid rgba(92, 45, 138, 0.75)', borderRadius: 12 }}
          title="Provenance record (held by you)"
        >
          ◈ {n} snapshot{n === 1 ? '' : 's'}{receiptCount > 0 ? ` · ${receiptCount} receipt${receiptCount === 1 ? '' : 's'}` : ''}
        </button>

        {panelOpen && (
          <div
            className="mt-1.5 bg-white overflow-auto"
            style={{ border: '1px solid rgba(92, 45, 138, 0.4)', borderRadius: 10, maxHeight: '40vh', width: 150 }}
          >
            {onVerifyChain && (
              <button
                type="button"
                onClick={onVerifyChain}
                className="w-full px-2.5 py-1.5 text-left hover:bg-stone-50"
                style={{ borderBottom: '1px solid rgba(92, 45, 138, 0.12)' }}
                title="Verify the signed receipt chain against the published key"
              >
                ✦ {chainStatus ? `chain: ${chainStatus}` : 'verify chain…'}
              </button>
            )}
            {onCheckBitcoin && pending && (
              <button
                type="button"
                onClick={onCheckBitcoin}
                className="w-full px-2.5 py-1.5 text-left hover:bg-stone-50"
                style={{ borderBottom: '1px solid rgba(92, 45, 138, 0.12)', color: '#9b5ccc' }}
              >
                ⏳ check Bitcoin…
              </button>
            )}
            {[...snapshots].reverse().map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => window.open(`/snapshot?doc=${encodeURIComponent(s.documentId)}&snap=${encodeURIComponent(s.id)}`, '_blank', 'noopener')}
                className="w-full px-2.5 py-1.5 flex items-baseline gap-1.5 text-left hover:bg-stone-50"
                style={{ borderBottom: '1px solid rgba(92, 45, 138, 0.12)' }}
                title="Open this version (read-only) — and see what changed since"
              >
                <span className="tabular-nums" style={{ color: '#9b5ccc' }}>
                  {new Date(s.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
                <span className="text-stone-500">{s.wordCount}w</span>
                <span className="ml-auto text-stone-400" title={`bundle ${s.bundleHash}`}>
                  {s.ots.status === 'confirmed' ? '⛓' : s.ots.status === 'pending' ? '⏳' : '·'} ↗
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  )
}
