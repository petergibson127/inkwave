// StyleMenu — "style" toolbar button with a drop-up panel for font / size / alignment.
// The chosen TextStyle is applied to the editor by the parent.

import { useEffect, useRef, useState } from 'react'

export interface TextStyle {
  font: string                              // CSS font-family
  size: string                              // CSS font-size
  align: 'left' | 'center' | 'justify'
}

export const DEFAULT_TEXT_STYLE: TextStyle = {
  font: "'IM Fell DW Pica', 'EB Garamond', Georgia, serif",
  size: '1.125rem',
  align: 'left',
}

const INK = '#5c2d8a'

const FONTS = [
  { label: 'Fell',     v: "'IM Fell DW Pica', 'EB Garamond', Georgia, serif" },
  { label: 'Garamond', v: "'EB Garamond', Georgia, serif" },
  { label: 'Sans',     v: "system-ui, -apple-system, 'Segoe UI', sans-serif" },
]
const SIZES = [
  { label: 'S', v: '1rem' },
  { label: 'M', v: '1.125rem' },
  { label: 'L', v: '1.375rem' },
]
const ALIGNS = [
  { label: 'Left',    v: 'left' as const },
  { label: 'Centre',  v: 'center' as const },
  { label: 'Justify', v: 'justify' as const },
]

function Seg<T extends string>({ options, value, onSelect }: {
  options: Array<{ label: string; v: T }>; value: T; onSelect: (v: T) => void
}) {
  return (
    <div className="flex gap-1">
      {options.map(o => (
        <button
          key={o.label}
          type="button"
          onClick={() => onSelect(o.v)}
          className={[
            'flex-1 rounded px-2 py-1 text-xs border transition-colors whitespace-nowrap',
            o.v === value
              ? 'border-[#5c2d8a] text-[#5c2d8a] bg-[#5c2d8a]/5'
              : 'border-stone-200 text-stone-500 hover:border-stone-300',
          ].join(' ')}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function StyleMenu({ style, onChange }: {
  style: TextStyle; onChange: (patch: Partial<TextStyle>) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  return (
    <div ref={rootRef} className="relative flex items-center font-serif">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        className="uppercase tracking-wide text-xs text-stone-400 hover:text-[#5c2d8a] transition-colors"
      >
        style
      </button>

      {open && (
        <div
          role="menu"
          className="absolute bottom-full right-0 mb-2 z-[60] w-56 p-3 bg-white shadow-md text-stone-600"
          style={{ border: `1px solid ${INK}66`, borderRadius: '10px' }}
        >
          <div className="space-y-2.5">
            <div>
              <div className="text-[0.6rem] uppercase tracking-wide text-stone-400 mb-1">Font</div>
              <Seg options={FONTS} value={style.font} onSelect={v => onChange({ font: v })} />
            </div>
            <div>
              <div className="text-[0.6rem] uppercase tracking-wide text-stone-400 mb-1">Size</div>
              <Seg options={SIZES} value={style.size} onSelect={v => onChange({ size: v })} />
            </div>
            <div>
              <div className="text-[0.6rem] uppercase tracking-wide text-stone-400 mb-1">Align</div>
              <Seg options={ALIGNS} value={style.align} onSelect={v => onChange({ align: v })} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
