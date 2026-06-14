// CaretGutter — an invisible click strip filling a side margin (left or right). It adds no
// layout (absolutely positioned, transparent, zero footprint in flow) and no visible mark;
// it only widens the target for the otherwise-fiddly "drop the caret at the very start (or
// end) of the line". Tapping beside a line places the caret before its first word (left) or
// after its last word (right); a drag selects text outward from there.
//
// Placement uses the LIVE pointer position against the current layout (no precomputed
// per-line boxes that could drift after a scroll or the phone keyboard opening).

import { useEffect, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import type { Editor } from '@tiptap/react'
import { TextSelection } from '@tiptap/pm/state'

type Side = 'left' | 'right'

type CaretDoc = Document & {
  caretRangeFromPoint?: (x: number, y: number) => Range | null
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
}

export function CaretGutter(
  { editor, containerEl, side = 'left' }:
  { editor: Editor; containerEl: RefObject<HTMLDivElement>; side?: Side },
) {
  // Width = the text column's distance from the matching viewport edge, so the strip fills
  // that whole margin and its outer edge sits exactly at the viewport edge — never
  // overflowing into horizontal scroll.
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = containerEl.current
    if (!el) return
    const update = () => {
      const r = el.getBoundingClientRect()
      const w = side === 'left' ? r.left : document.documentElement.clientWidth - r.right
      setWidth(Math.max(0, w))
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [containerEl, side])

  // The x just inside the text column on this side — the line start (left) or end (right).
  const edgeX = (rect: DOMRect) => (side === 'left' ? rect.left + 2 : rect.right - 2)

  // Drop a collapsed caret at pos, fixing WebKit's wrap-boundary affinity. A position at a
  // soft wrap is visually shared by two lines; setTextSelection can render it on the wrong
  // one (WebKit). Re-place the DOM caret from a POINT on the intended line's glyph: left
  // wants the lower line (bias +1, just right of the caret x), right wants the upper line
  // (bias -1, just left of it). A Range from a point there carries that line's affinity,
  // exactly as a real click does, for any node structure.
  function placeCaret(pos: number) {
    const view = editor.view
    editor.chain().focus().setTextSelection(pos).run()
    try {
      const c = view.coordsAtPos(pos, side === 'left' ? 1 : -1)
      const gx = side === 'left' ? c.left + 2 : c.left - 2
      const gy = (c.top + c.bottom) / 2
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
    } catch { /* coords/caret APIs unavailable — keep the caret as set */ }
  }

  function onPointerDown(e: ReactPointerEvent) {
    e.preventDefault() // we drive the caret/selection ourselves; suppress the margin click
    const view = editor.view
    const rect = view.dom.getBoundingClientRect()
    // posAtCoords maps any y in the (tall, 2.5-line-height) line band to the right line.
    const at = view.posAtCoords({ left: edgeX(rect), top: e.clientY })
    if (!at) return
    let anchor = at.pos
    if (side === 'right') {
      // At a wrapped line's right edge posAtCoords lands PAST the wrap space (= start of the
      // next line); step back over trailing whitespace so the caret sits after this line's
      // last word. (No-op on the last line, which has no trailing wrap space.)
      const doc = view.state.doc
      let guard = 0
      while (anchor > 0 && guard++ < 200 && /\s/.test(doc.textBetween(anchor - 1, anchor))) anchor--
    }
    placeCaret(anchor) // a plain click leaves this collapsed caret (with the affinity fix)

    // Dragging out of the margin extends a selection from the line edge to the pointer.
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
      // Clamp x into the text column so a pointer still in the margin reads as the line edge.
      const x = side === 'left'
        ? Math.max(ev.clientX, rect.left + 2)
        : Math.min(ev.clientX, rect.right - 2)
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

  const placement = side === 'left' ? { left: -width } : { right: -width }
  return (
    <div
      aria-hidden
      onPointerDown={onPointerDown}
      // pointerdown's preventDefault doesn't stop the compatibility mousedown, which
      // ProseMirror reads for selection — block it so it can't override our handling.
      onMouseDown={e => e.preventDefault()}
      className="absolute pointer-events-auto"
      style={{ top: 0, bottom: 0, width, cursor: 'text', touchAction: 'none', ...placement }}
    />
  )
}
