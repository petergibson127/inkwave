// LimitSelector — compact "lim" control with a drop-up menu for the SCAS vocab cap.
//
// Options: 500 / 1000 / 2000 / 4000 / ∞ (infinite). Opens upward since it lives in the
// bottom toolbar. A value not in the list (e.g. an older 5000 doc) still displays.

import { useEffect, useRef, useState } from 'react'

interface LimitSelectorProps {
  value: number | 'infinite'
  onChange: (next: number | 'infinite') => void
}

const INK = '#5c2d8a'

const OPTIONS: Array<{ label: string; value: number | 'infinite' }> = [
  { label: '500',  value: 500 },
  { label: '1000', value: 1000 },
  { label: '2000', value: 2000 },
  { label: '4000', value: 4000 },
  { label: '∞',    value: 'infinite' },
]

const labelFor = (v: number | 'infinite') =>
  OPTIONS.find(o => o.value === v)?.label ?? (v === 'infinite' ? '∞' : String(v))

export function LimitSelector({ value, onChange }: LimitSelectorProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  return (
    <div ref={rootRef} className="relative flex items-center gap-2 text-sm text-stone-400 select-none font-serif">
      <span className="tracking-wide uppercase text-xs">lim</span>

      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        className="min-w-[3.25rem] rounded border border-stone-300 px-2 py-0.5 text-center text-stone-500 hover:border-stone-400 transition-colors"
      >
        {labelFor(value)}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-[2.25rem] mb-2 z-[60] w-24 py-1 bg-white shadow-md text-sm text-stone-600 font-serif"
          style={{ border: `1px solid ${INK}66`, borderRadius: '8px' }}
        >
          {OPTIONS.map(o => (
            <button
              key={o.label}
              role="menuitem"
              type="button"
              onClick={() => { onChange(o.value); setOpen(false) }}
              className={[
                'w-full text-left px-3 py-1 hover:bg-stone-100 hover:text-[#5c2d8a] transition-colors',
                o.value === value ? 'text-[#5c2d8a]' : '',
              ].join(' ')}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
