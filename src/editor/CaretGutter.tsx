// CaretGutter — an invisible click strip filling the left margin. It adds no layout
// (absolutely positioned, transparent, zero footprint in flow) and no visible mark; it
// only widens the target for the otherwise-fiddly "drop the caret at the very start of
// the line". Tapping beside a line places the caret before that line's first word.
//
// Placement uses the LIVE pointer Y against the current layout (no precomputed per-line
// boxes that could drift out of alignment after a scroll or the phone keyboard opening).

import { useEffect, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react'
import type { Editor } from '@tiptap/react'

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

  function place(e: ReactPointerEvent) {
    e.preventDefault() // we set the caret ourselves; suppress the default margin-click
    const view = editor.view
    const rect = view.dom.getBoundingClientRect()
    // posAtCoords maps any y in the (tall, 2.5-line-height) line band to the right line.
    const at = view.posAtCoords({ left: rect.left + 2, top: e.clientY })
    if (!at) return

    // Set the document position (also focuses). This alone renders a wrap-boundary caret
    // with "upstream" affinity on WebKit — i.e. at the END of the previous line.
    editor.chain().focus().setTextSelection(at.pos).run()

    // Fix that affinity: re-place the DOM caret from a POINT on the downstream line's
    // glyph. coordsAtPos(pos, 1) gives that line's coordinates; a Range built from a point
    // there carries the line's affinity (the same path a real click takes), so the caret
    // renders on the tapped line. This works regardless of node structure — unlike
    // domAtPos, which only disambiguates when the next line starts a new text node.
    type CaretDoc = Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
    }
    try {
      const c = view.coordsAtPos(at.pos, 1)
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

  return (
    <div
      aria-hidden
      onPointerDown={place}
      // pointerdown's preventDefault doesn't stop the compatibility mousedown, which
      // ProseMirror reads for selection — block it so it can't override our placement.
      onMouseDown={e => e.preventDefault()}
      className="absolute pointer-events-auto"
      style={{ top: 0, bottom: 0, left: -width, width, cursor: 'text' }}
    />
  )
}
