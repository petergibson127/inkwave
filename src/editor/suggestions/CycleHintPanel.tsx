// CycleHintPanel — Stage B keyboard hint overlay.
//
// Shown only while the word cycle is active.
// Desktop: fixed panel in the right viewport margin, vertically centred.
// Mobile:  fixed strip along the bottom edge.

interface Hint {
  keys: string
  label: string
}

const HINTS: Hint[] = [
  { keys: 'j / k',    label: 'cycle'     },
  { keys: 'space',    label: 'accept'    },
  { keys: 'tab',      label: 'prev word' },
  { keys: '⇧ tab',   label: 'next word' },
  { keys: 'esc',      label: 'dismiss'   },
]

interface CycleHintPanelProps {
  active: boolean
  showHints: boolean
}

export function CycleHintPanel({ active, showHints }: CycleHintPanelProps) {
  if (!active || !showHints) return null

  return (
    <>
      {/* ── Desktop: right-edge panel ───────────────────────────────────────── */}
      <div
        aria-hidden="true"
        className="hidden md:grid fixed right-6 top-24 z-40
                   pointer-events-none select-none
                   bg-white pl-2 pr-4 py-3 shadow-sm"
        style={{ border: '1px solid rgba(210, 140, 60, 0.6)', borderRadius: '15%', gridTemplateColumns: 'auto auto', gap: '0.625rem 0.5rem' }}
      >
        {HINTS.map(({ keys, label }) => (
          <>
            <span key={keys + '-k'} className="font-mono text-sm text-stone-400 text-right whitespace-nowrap">
              {keys}
            </span>
            <span key={keys + '-l'} className="text-sm text-stone-600 whitespace-nowrap">
              {label}
            </span>
          </>
        ))}
      </div>

      {/* ── Mobile: bottom strip ────────────────────────────────────────────── */}
      <div
        aria-hidden="true"
        className="flex md:hidden fixed bottom-0 left-0 right-0 z-40
                   justify-center gap-5 pb-3 pt-2 pointer-events-none select-none
                   bg-gradient-to-t from-parchment/90 to-transparent"
      >
        {HINTS.map(({ keys, label }) => (
          <div key={keys} className="flex items-baseline gap-1">
            <span className="font-mono text-xs text-stone-400">{keys}</span>
            <span className="text-xs text-stone-300">{label}</span>
          </div>
        ))}
      </div>
    </>
  )
}
