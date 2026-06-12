import { useState } from 'react'
import type { Snapshot } from '../types/document'

// Minimal M1 receipt panel: the growing record of tamper-evident snapshots the writer holds.
// Snapshots accrue on a resolved kick when the content changed. Later milestones add OTS status
// (M2 → Bitcoin), the signed receipt chain + kick log (M3), and the friction score (M5).
export function ReceiptPanel({ snapshots }: { snapshots: Snapshot[] }) {
  const [open, setOpen] = useState(false)
  const n = snapshots.length

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
        ◈ {n} snapshot{n === 1 ? '' : 's'}
      </button>

      {open && n > 0 && (
        <div
          className="mt-1.5 bg-white overflow-auto"
          style={{
            border: '1px solid rgba(92, 45, 138, 0.4)',
            borderRadius: 10,
            maxHeight: '40vh',
            minWidth: 230,
          }}
        >
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
