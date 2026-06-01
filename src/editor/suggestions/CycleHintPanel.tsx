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
  { keys: '⇧+tab',   label: 'next word' },
  { keys: 'esc',      label: 'dismiss'   },
]

interface CycleHintPanelProps {
  active: boolean
  showHints: boolean
  containerRight: number
}

export function CycleHintPanel({ active, showHints, containerRight }: CycleHintPanelProps) {
  if (!active || !showHints) return null

  return (
    <>
      {/* ── Desktop: right-edge panel ───────────────────────────────────────── */}
      <div
        aria-hidden="true"
        className="hidden min-[720px]:grid fixed z-40
                   pointer-events-none select-none
                   bg-white pl-2 pr-4 py-3 shadow-sm"
        style={{ border: '1px solid rgba(180, 90, 10, 0.85)', borderRadius: '10px', gridTemplateColumns: 'auto auto', gap: '0.625rem 0.5rem', top: '20vh', left: containerRight - 82 }}
      >
        {HINTS.map(({ keys, label }) => (
          <>
            <span key={keys + '-k'} className="font-mono text-xs text-stone-400 text-right whitespace-nowrap">
              {keys.startsWith('⇧') ? <><strong>⇧</strong>{keys.slice(1)}</> : keys}
            </span>
            <span key={keys + '-l'} className="text-xs text-stone-600 whitespace-nowrap">
              {label}
            </span>
          </>
        ))}
      </div>

      {/* Mobile hint strip intentionally omitted — tap controls are self-evident */}
    </>
  )
}
