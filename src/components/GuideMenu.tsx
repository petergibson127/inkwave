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
        <div
          role="menu"
          className="absolute bottom-full right-0 mb-2 z-[60] w-64 p-3 bg-white shadow-md text-stone-600"
          style={{ border: `1px solid ${INK}66`, borderRadius: '10px' }}
        >
          <div className="text-[0.6rem] uppercase tracking-wide text-stone-400 mb-1.5">Keyboard (desktop)</div>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            {KEYS.map(({ k, d }) => (
              <Fragment key={k}>
                <span className="font-mono text-xs text-stone-500 text-right whitespace-nowrap">{k}</span>
                <span>{d}</span>
              </Fragment>
            ))}
          </div>
          <div className="mt-2.5 pt-2.5 border-t border-stone-200 text-xs text-stone-500 leading-snug">
            Bold, italics, underline, <span className="font-mono">/</span> (bullets &amp; numbers) and
            comma will be handled by a built-in IME <span className="text-stone-400">(coming soon)</span>.
          </div>
        </div>
      )}
    </div>
  )
}
