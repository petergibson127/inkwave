import type { Editor } from '@tiptap/react'
import type { LineRange } from './popoverConstants'

// Returns the PM position of el, or -1 on failure.
export function posOf(el: Element, editor: Editor): number {
  try { return editor.view.posAtDOM(el.firstChild ?? el, 0) } catch { return -1 }
}

// Rightmost visual char on the same line as rect, walking text nodes in paraEl.
// Known limitation: non-text inline content (images, widgets) is invisible to this
// walker — naturalLineRight will be underestimated. Fine for prose-only paragraphs.
export function measureNaturalLineRight(rect: DOMRect, pEl: Element): number {
  let right = rect.right
  const tw = document.createTreeWalker(pEl, NodeFilter.SHOW_TEXT)
  const rng = document.createRange()
  for (;;) {
    const nd = tw.nextNode() as Text | null
    if (!nd) break
    rng.setStart(nd, 0); rng.setEnd(nd, nd.length)
    const nr = rng.getBoundingClientRect()
    if (nr.bottom < rect.top - 2 || nr.top > rect.bottom + 2) continue
    for (let i = 0; i < nd.length; i++) {
      rng.setStart(nd, i); rng.setEnd(nd, i + 1)
      const cr = rng.getBoundingClientRect()
      if (cr.bottom >= rect.top && cr.top <= rect.bottom && cr.right > right) right = cr.right
    }
  }
  return right
}

// Computes negative letter-spacing range to absorb the focused word's min-width
// expansion without paragraph overflow.  Dispatched atomically with the min-width
// so there is no intermediate painted frame where the word is expanded but not yet
// compressed.
//
// .scas-red is display:inline-block (~45px box); midpoint±tolerance is used for
// same-line detection so adjacent-line chars inside the tall box are excluded.
export function computeLineCompressionRange(
  naturalTop: number, naturalBottom: number, naturalLineRight: number,
  naturalWidth: number, minWidth: number, wordFrom: number, wordTo: number,
  paraEl: Element, editor: Editor,
): LineRange | null {
  const midY = (naturalTop + naturalBottom) / 2
  const tol  = (naturalBottom - naturalTop) * 0.45

  let lineFrom: number | null = null, lineFromX = Infinity
  let lineTo:   number | null = null
  let nBefore = 0, nAfter = 0

  const w = document.createTreeWalker(paraEl, NodeFilter.SHOW_TEXT)
  const r = document.createRange()
  for (;;) {
    const nd = w.nextNode() as Text | null
    if (!nd) break
    if (!nd.length) continue
    r.setStart(nd, 0); r.setEnd(nd, nd.length)
    const nr = r.getBoundingClientRect()
    if (nr.bottom < naturalTop - 2 || nr.top > naturalBottom + 2) continue
    for (let i = 0; i < nd.length; i++) {
      r.setStart(nd, i); r.setEnd(nd, i + 1)
      const cr = r.getBoundingClientRect()
      if (Math.abs((cr.top + cr.bottom) / 2 - midY) >= tol) continue
      try {
        const p = editor.view.posAtDOM(nd, i)
        if (p < wordFrom) { nBefore++; if (cr.left < lineFromX) { lineFromX = cr.left; lineFrom = p } }
        else if (p >= wordTo) { nAfter++; if (lineTo === null || p + 1 > lineTo) lineTo = p + 1 }
      } catch { /* skip non-editable nodes */ }
    }
  }

  if (nBefore + nAfter === 0) return null

  const paraRight = paraEl.getBoundingClientRect().right
  const slack = Math.max(0, paraRight - naturalLineRight)
  const exp   = Math.max(0, Math.ceil(minWidth) - naturalWidth)
  if (exp === 0) return null
  const half  = exp / 2   // ideal: reserve half the expansion on each side of the word

  const fe  = editor.view.dom.querySelector('.scas-focused') as HTMLElement | null
  const fsz = parseFloat(fe ? window.getComputedStyle(fe).fontSize : '18') || 18

  // Room between the word's natural right edge and the paragraph's right edge. (fe carries
  // min-width:naturalWidth at this point, so its right edge is the natural right edge.)
  const wordRight = fe ? fe.getBoundingClientRect().right : naturalLineRight
  const rightRoom = Math.max(0, paraRight - wordRight)
  // Slide the box left by `half` (centred) when there's at least half a room on the right;
  // when the word hugs the right edge, slide it further so the expanded box still fits the
  // line instead of wrapping. (A right-edge word then sits slightly left of centre — the
  // unavoidable edge case — but never wraps.)
  const beforeShift = Math.min(exp, Math.max(half, exp - rightRoom))

  // Keep the line's first word uncompressed (squeezing it would jitter the line start);
  // count its chars so the before-compression starts just after it.
  let fwc = 0
  if (lineFrom !== null) {
    const dz = editor.state.doc.content.size
    for (let p = lineFrom; p < wordFrom && p + 1 <= dz; p++) {
      try { const c = editor.state.doc.textBetween(p, p + 1); if (/[ \t\xa0]/.test(c)) break; fwc++ }
      catch { break }
    }
  }
  const firstWordEnd = (lineFrom ?? wordFrom) + fwc

  // BEFORE: compress [firstWordEnd, wordFrom] by `beforeShift` so the word's box — and the
  // before-neighbour — slide left by that much, centring (or fitting) the reserved box.
  const nBeforeComp = nBefore - fwc
  const lsBeforeEm  = nBeforeComp > 0 ? beforeShift / nBeforeComp / fsz : 0
  // AFTER: the box pushes the after-text right by (exp - beforeShift); compress it only by
  // the part that exceeds the line's right-hand slack — the rest extends into the slack.
  const afterPush   = Math.max(0, (exp - beforeShift) - slack)
  const lsAfterEm   = nAfter > 0 ? afterPush / nAfter / fsz : 0

  if (lsBeforeEm === 0 && lsAfterEm === 0) return null
  return { from: lineFrom ?? wordFrom, firstWordEnd, to: lineTo ?? wordTo, lsBeforeEm, lsAfterEm }
}
