// CaretGutter — an invisible click strip filling the left margin. It adds no layout
// (absolutely positioned, transparent, zero footprint in flow) and no visible mark; it
// only widens the target for the otherwise-fiddly "drop the caret at the very start of
// the line". Tapping beside a line places the caret before that line's first word; a
// drag from the margin selects text outward from that line start.
//
// Placement uses the LIVE pointer position against the current layout (no precomputed
// per-line boxes that could drift after a scroll or the phone keyboard opening).

import { useEffect, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import type { Editor } from '@tiptap/react'
import { TextSelection } from '@tiptap/pm/state'

type CaretDoc = Document & {
  caretRangeFromPoint?: (x: number, y: number) => Range | null
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
}

export function CaretGutter(
  { editor, containerEl }: { editor: Editor; containerEl: RefObject<HTMLDivElement> },
) {
  // Width = the text column's distance from the viewport's left edge, so the strip fills
  // the whole left margin (generous on desktop, the full sliver on a phone) and its left
  // edge sits exactly at the viewport edge — never overflowing into horizontal scroll.
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = containerEl.current
    if (!el) return
    const update = () => setWidth(Math.max(0, el.getBoundingClientRect().left))
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [containerEl])

  // Drop a collapsed caret at pos, fixing WebKit's upstream wrap-boundary affinity:
  // setTextSelection alone renders a wrap-boundary caret at the END of the previous line,
  // so re-place the DOM caret from a POINT on the downstream line's glyph (coordsAtPos(pos,
  // 1) gives that line's coords; a Range from a point there carries the line's affinity —
  // the same path a real click takes). Works for any node structure.
  function placeCaret(pos: number) {
    const view = editor.view
    editor.chain().focus().setTextSelection(pos).run()
    try {
      const c = view.coordsAtPos(pos, 1)
      const gx = c.left + 2, gy = (c.top + c.bottom) / 2
      const d = document as CaretDoc
      let range: Range | null = null
      if (d.caretRangeFromPoint) {
        range = d.caretRangeFromPoint(gx, gy)
      } else if (d.caretPositionFromPoint) {
        const p = d.caretPositionFromPoint(gx, gy)
        if (p) { range = document.createRange(); range.setStart(p.offsetNode, p.offset) }
      }
      if (range && view.dom.contains(range.startContainer)) {
        range.collapse(true)
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
      }
    } catch { /* coords/caret APIs unavailable — keep the upstream caret */ }
  }

  function onPointerDown(e: ReactPointerEvent) {
    e.preventDefault() // we drive the caret/selection ourselves; suppress the margin click
    const view = editor.view
    const rect = view.dom.getBoundingClientRect()
    // posAtCoords maps any y in the (tall, 2.5-line-height) line band to the right line.
    const at = view.posAtCoords({ left: rect.left + 2, top: e.clientY })
    if (!at) return
    const anchor = at.pos
    placeCaret(anchor) // a plain click leaves this collapsed caret (with the affinity fix)

    // Dragging out of the margin extends a selection from the line start to the pointer.
    const strip = e.currentTarget as HTMLElement
    try { strip.setPointerCapture(e.pointerId) } catch { /* older browsers */ }
    let dragging = false
    let raf = 0
    let head = anchor
    const apply = () => {
      raf = 0
      const sel = TextSelection.create(view.state.doc, anchor, head)
      view.dispatch(view.state.tr.setSelection(sel))
    }
    const onMove = (ev: PointerEvent) => {
      // Clamp x into the text column so a pointer still in the margin reads as the line start.
      const x = Math.max(ev.clientX, rect.left + 2)
      const h = view.posAtCoords({ left: x, top: ev.clientY })
      if (!h) return
      if (h.pos !== anchor) dragging = true
      if (!dragging) return // tiny jitter before a real drag — keep the affinity-fixed caret
      head = h.pos
      if (!raf) raf = requestAnimationFrame(apply)
    }
    const onUp = (ev: PointerEvent) => {
      try { strip.releasePointerCapture(ev.pointerId) } catch { /* noop */ }
      strip.removeEventListener('pointermove', onMove)
      strip.removeEventListener('pointerup', onUp)
      strip.removeEventListener('pointercancel', onUp)
      if (raf) { cancelAnimationFrame(raf); apply() }
    }
    strip.addEventListener('pointermove', onMove)
    strip.addEventListener('pointerup', onUp)
    strip.addEventListener('pointercancel', onUp)
  }

  return (
    <div
      aria-hidden
      onPointerDown={onPointerDown}
      // pointerdown's preventDefault doesn't stop the compatibility mousedown, which
      // ProseMirror reads for selection — block it so it can't override our handling.
      onMouseDown={e => e.preventDefault()}
      className="absolute pointer-events-auto"
      style={{ top: 0, bottom: 0, left: -width, width, cursor: 'text', touchAction: 'none' }}
    />
  )
}
