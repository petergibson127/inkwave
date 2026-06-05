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

    // So re-point the DOM caret at the *downstream* side of the same position
    // (domAtPos(pos, 1) = the content that follows it, which is on the new line). The PM
    // state is unchanged, so PM won't re-render and clobber it; the caret now sits on the
    // line the writer tapped beside. Harmless for non-boundary positions.
    try {
      const dp = view.domAtPos(at.pos, 1)
      window.getSelection()?.collapse(dp.node, dp.offset)
    } catch { /* domAtPos can throw at atom boundaries — keep the upstream caret */ }
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
