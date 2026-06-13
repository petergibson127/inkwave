import { useState } from 'react'
import type { Snapshot } from '../types/document'

// Minimal M1 receipt panel: the growing record of tamper-evident snapshots the writer holds.
// Snapshots accrue on a resolved kick when the content changed. Later milestones add OTS status
// (M2 → Bitcoin), the signed receipt chain + kick log (M3), and the friction score (M5).
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
  const n = snapshots.length
  const pending = snapshots.some((s) => s.ots.status === 'pending')

  return (
    <div
      className="fixed bottom-4 left-4 z-40 font-serif text-xs select-none"
      style={{ color: '#5c2d8a' }}
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

      {open && (n > 0 || receiptCount > 0) && (
        <div
          className="mt-1.5 bg-white overflow-auto"
          style={{
            border: '1px solid rgba(92, 45, 138, 0.4)',
            borderRadius: 10,
            maxHeight: '40vh',
            minWidth: 230,
          }}
        >
          {onVerifyChain && (
            <button
              type="button"
              onClick={onVerifyChain}
              className="w-full px-2.5 py-1.5 text-left hover:bg-stone-50"
              style={{ borderBottom: '1px solid rgba(92, 45, 138, 0.12)' }}
              title="Verify the signed receipt chain against the published key"
            >
              ✦ live-composition: {receiptCount} signed {receiptCount === 1 ? 'receipt' : 'receipts'}
              {chainStatus ? ` — ${chainStatus}` : ' · verify…'}
            </button>
          )}
          {onCheckBitcoin && pending && (
            <button
              type="button"
              onClick={onCheckBitcoin}
              className="w-full px-2.5 py-1.5 text-left hover:bg-stone-50"
              style={{ borderBottom: '1px solid rgba(92, 45, 138, 0.12)', color: '#9b5ccc' }}
            >
              ⏳ check Bitcoin confirmation…
            </button>
          )}
          {[...snapshots].reverse().map((s) => (
            <div key={s.id} className="px-2.5 py-1.5 flex items-baseline gap-2"
                 style={{ borderBottom: '1px solid rgba(92, 45, 138, 0.12)' }}>
              <span className="tabular-nums" style={{ color: '#9b5ccc' }}>
                {new Date(s.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
              <span className="text-stone-500">{s.wordCount}w</span>
              <span className="font-mono text-stone-400" title={`bundle ${s.bundleHash}`}>
                {s.bundleHash.slice(0, 8)}
              </span>
              <span className="ml-auto text-stone-400">
                {s.ots.status === 'confirmed' ? '⛓ Bitcoin' : s.ots.status === 'pending' ? '⏳ pending' : '· local'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
