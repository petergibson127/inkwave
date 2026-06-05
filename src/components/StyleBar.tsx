// StyleBar — a flat row of formatting controls that sits flush above the main toolbar.
// Everything acts on the current selection (commands run without .focus() so the editor's
// focus/selection is preserved); "all" applies the selection's style to the whole document.

import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'

const INK = '#5c2d8a'
const BASE_SIZE = 18

const FONTS = [
  { label: 'Fell',     css: "'IM Fell DW Pica', 'EB Garamond', Georgia, serif" },
  { label: 'Garamond', css: "'EB Garamond', Georgia, serif" },
  { label: 'Sans',     css: "system-ui, -apple-system, 'Segoe UI', sans-serif" },
]

type Align = 'left' | 'center' | 'justify'

function AlignIcon({ a }: { a: Align }) {
  const lines: Record<Align, Array<[number, number]>> = {
    left:    [[2, 12], [2, 8], [2, 11]],
    center:  [[2, 12], [4, 10], [3, 11]],
    justify: [[2, 12], [2, 12], [2, 12]],
  }
  const ys = [3.5, 7, 10.5]
  return (
    <svg width="15" height="15" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
      {lines[a].map(([x1, x2], i) => <line key={i} x1={x1} y1={ys[i]} x2={x2} y2={ys[i]} />)}
    </svg>
  )
}

export function StyleBar({ editor, onActivity }: { editor: Editor; onActivity?: () => void }) {
  const [, force] = useState(0)
  const [fontOpen, setFontOpen] = useState(false)
  const fontRef = useRef<HTMLDivElement>(null)
  const ping = () => onActivity?.()

  // Re-render when the selection/content changes so the controls reflect the cursor.
  useEffect(() => {
    const upd = () => force(n => n + 1)
    editor.on('selectionUpdate', upd)
    editor.on('transaction', upd)
    return () => { editor.off('selectionUpdate', upd); editor.off('transaction', upd) }
  }, [editor])

  useEffect(() => {
    if (!fontOpen) return
    const onDown = (e: MouseEvent) => { if (fontRef.current && !fontRef.current.contains(e.target as Node)) setFontOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [fontOpen])

  const ts = editor.getAttributes('textStyle')
  const curFont = FONTS.find(f => f.css === ts.fontFamily)?.label ?? 'Fell'
  const curSize = parseInt(ts.fontSize ?? '', 10) || BASE_SIZE
  const curAlign: Align = (['left', 'center', 'justify'] as const).find(a => editor.isActive({ textAlign: a })) ?? 'left'

  const setFont  = (css: string) => { ping(); editor.chain().setFontFamily(css).run(); setFontOpen(false) }
  const setSize  = (px: number) => { ping(); if (px >= 8 && px <= 120) editor.chain().setMark('textStyle', { fontSize: `${px}px` }).run() }
  const setAlign = (a: Align) => { ping(); editor.chain().setTextAlign(a).run() }

  // Apply the current selection's style (font / size / align) to the whole document.
  const applyToAll = () => {
    ping()
    const { from, to } = editor.state.selection
    const chain = editor.chain().selectAll()
    if (ts.fontFamily) chain.setFontFamily(ts.fontFamily)
    if (ts.fontSize)   chain.setMark('textStyle', { fontSize: ts.fontSize })
    chain.setTextAlign(curAlign).setTextSelection({ from, to }).run()
  }

  const segBtn = (active: boolean) =>
    `flex items-center justify-center rounded px-1.5 py-1 transition-colors ${active ? 'text-[#5c2d8a] bg-[#5c2d8a]/10' : 'text-stone-400 hover:text-[#5c2d8a]'}`

  return (
    <div className="flex items-center gap-2 text-sm text-stone-500 font-serif w-full">
      {/* Font drop-up */}
      <div ref={fontRef} className="relative">
        <button type="button" aria-haspopup="menu" aria-expanded={fontOpen}
          onClick={() => setFontOpen(o => !o)}
          className="rounded border border-stone-300 px-2 py-0.5 text-stone-500 hover:border-stone-400 transition-colors min-w-[4.5rem] text-left">
          {curFont} <span className="text-[0.6em] align-middle">▴</span>
        </button>
        {fontOpen && (
          <div role="menu" className="absolute bottom-full left-0 mb-2 z-[60] w-28 py-1 bg-white shadow-md"
            style={{ border: `1px solid ${INK}66`, borderRadius: '8px' }}>
            {FONTS.map(f => (
              <button key={f.label} role="menuitem" type="button" onClick={() => setFont(f.css)}
                className={`w-full text-left px-3 py-1 hover:bg-stone-100 hover:text-[#5c2d8a] ${f.label === curFont ? 'text-[#5c2d8a]' : 'text-stone-600'}`}
                style={{ fontFamily: f.css }}>
                {f.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Size (numeric) */}
      <input
        type="number" min={8} max={120} value={curSize}
        onChange={e => setSize(parseInt(e.target.value, 10))}
        aria-label="Font size"
        className="w-14 rounded border border-stone-300 px-2 py-0.5 text-center text-stone-500 focus:outline-none focus:border-stone-400"
      />

      {/* Alignment */}
      <div className="flex items-center gap-0.5">
        {(['left', 'center', 'justify'] as const).map(a => (
          <button key={a} type="button" aria-label={`Align ${a}`} aria-pressed={curAlign === a}
            onClick={() => setAlign(a)} className={segBtn(curAlign === a)}>
            <AlignIcon a={a} />
          </button>
        ))}
      </div>

      {/* Apply to whole document */}
      <button type="button" onClick={applyToAll}
        className="ml-auto rounded border border-stone-300 px-2 py-0.5 text-xs uppercase tracking-wide text-stone-500 hover:border-[#5c2d8a] hover:text-[#5c2d8a] transition-colors whitespace-nowrap">
        all
      </button>
    </div>
  )
}
