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

  const fe  = editor.view.dom.querySelector('.scas-focused') as HTMLElement | null
  const fsz = parseFloat(fe ? window.getComputedStyle(fe).fontSize : '18') || 18

  // fe carries min-width:naturalWidth here, so its rect is the word's natural box.
  const wordRight = fe ? fe.getBoundingClientRect().right : naturalLineRight
  const rightRoom = Math.max(0, paraRight - wordRight)
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
  const nBeforeComp = nBefore - fwc

  // POSITION-PROPORTIONAL slide. fPos = where the word's centre sits along its visual line
  // (0 = left, 1 = right). Slide the box left by fPos·exp: a left-edge word slides 0 (grows
  // rightward), a right-edge word slides exp (grows LEFTWARD — so it never overflows the
  // right), a mid word slides half (centres). This is a true left→right continuum and still
  // lands the word on its natural x (the reel aligns at the same fraction).
  const wordLeft   = wordRight - naturalWidth
  const wordCentre = wordRight - naturalWidth / 2
  const lineLeft   = Number.isFinite(lineFromX) ? Math.min(lineFromX, wordLeft) : wordLeft
  const fPos       = Math.max(0, Math.min(1, (wordCentre - lineLeft) / Math.max(1, naturalLineRight - lineLeft)))
  // Cap by what the before-text can readably give up; also guarantee the box fits the right
  // (exp - rightRoom) so it never wraps even if proportional alone would be a touch short.
  const MAX_LS_EM = 0.14
  const maxShift  = Math.max(0, nBeforeComp) * MAX_LS_EM * fsz
  const beforeShift = Math.min(maxShift, Math.max(fPos * exp, exp - rightRoom))

  // BEFORE: compress [firstWordEnd, wordFrom] by `beforeShift` so the box — and the
  // before-neighbour — slide left by that much, centring (or fitting) the reserved box.
  const lsBeforeEm  = nBeforeComp > 0 ? beforeShift / nBeforeComp / fsz : 0
  // AFTER: the box pushes the after-text right by (exp - beforeShift); compress it only by
  // the part that exceeds the line's right-hand slack — the rest extends into the slack.
  const afterPush   = Math.max(0, (exp - beforeShift) - slack)
  const lsAfterEm   = nAfter > 0 ? afterPush / nAfter / fsz : 0

  if (lsBeforeEm === 0 && lsAfterEm === 0) return null
  // The box only actually slides left when the before-side compresses; otherwise it grows
  // rightward from its natural left, so the reel must left-align (fraction 0).
  const alignFraction = lsBeforeEm > 0 ? beforeShift / exp : 0
  return { from: lineFrom ?? wordFrom, firstWordEnd, to: lineTo ?? wordTo, lsBeforeEm, lsAfterEm, alignFraction }
}
