// GuideMenu — "guide" toolbar button with a drop-up info panel: the desktop hotkeys
// for the word cycle, plus a note about the formatting IME still to be built.

import { Fragment, useEffect, useRef, useState } from 'react'

const INK = '#5c2d8a'

const KEYS: Array<{ k: string; d: string }> = [
  { k: 'j / k',  d: 'cycle synonyms' },
  { k: 'space',  d: 'accept' },
  { k: 'tab',    d: 'previous word' },
  { k: '⇧+tab',  d: 'next word' },
  { k: 'esc',    d: 'dismiss' },
]

export function GuideMenu() {
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
        guide
      </button>

      {open && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" onMouseDown={() => setOpen(false)}>
          <div className="absolute inset-0 bg-stone-900/20" aria-hidden="true" />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Guide"
            onMouseDown={(e) => e.stopPropagation()}
            className="relative w-full max-w-sm p-6 bg-white shadow-xl text-stone-600"
            style={{ border: `1px solid ${INK}bf`, borderRadius: '14px' }}
          >
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-serif" style={{ color: INK }}>Guide</h2>
              <button type="button" aria-label="Close" onClick={() => setOpen(false)} className="text-stone-400 hover:text-[#5c2d8a] text-2xl leading-none">×</button>
            </div>
            <div className="text-[0.65rem] uppercase tracking-wide text-stone-400 mb-1.5">Keyboard (desktop)</div>
            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-base">
              {KEYS.map(({ k, d }) => (
                <Fragment key={k}>
                  <span className="font-mono text-sm text-stone-500 text-right whitespace-nowrap">{k}</span>
                  <span>{d}</span>
                </Fragment>
              ))}
            </div>
            <div className="mt-3 pt-3 border-t border-stone-200 text-sm text-stone-500 leading-snug">
              Bold, italics, underline, <span className="font-mono">/</span> (bullets &amp; numbers) and
              comma will be handled by a built-in IME <span className="text-stone-400">(coming soon)</span>.
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
