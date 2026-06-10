import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { getSynonyms } from '../thesaurus'
import { getFont } from '../textMetrics'
import { CYCLE_SIZE, DELETE_SENTINEL, REFLOW_OPEN_MS, REFLOW_COMMIT_MS } from './popoverConstants'
import type { CycleState, OnHintChange, LineRange } from './popoverConstants'
import { posOf, measureNaturalLineRight, computeLineCompressionRange, lineEndPosAfter } from './popoverGeometry'
import { buildSynonyms } from './popoverFallbacks'

// The in-place expand+compress popover is the experience on every device. The opaque
// overlay card is a dormant fallback, opt-in via ?overlay=1 only — used to compare or
// in case the in-place spacing can't be made reliable on iOS.
function wantsOverlay(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return new URLSearchParams(window.location.search).get('overlay') === '1'
  } catch { return false }
}

// FLIP the after-text slide on commit/close instead of snapping it: the layout still changes in
// ONE step (one reflow, no per-frame layout = no lag), but the after-run is then pulled back to
// where it was with a compositor transform and eased to 0 — so the surrounding text slides
// smoothly. ON by default; ?flip=0 falls back to the instant snap (kept as a debug escape hatch).
function wantsFlip(): boolean {
  if (typeof window === 'undefined') return true
  try {
    return new URLSearchParams(window.location.search).get('flip') !== '0'
  } catch { return true }
}

export function usePopoverLayout(
  editor: Editor,
  onHintChange: OnHintChange,
) {
  const [cycle, setCycle] = useState<CycleState | null>(null)
  const [, forceUpdate]   = useState(0)

  // Re-render on resize/scroll so live DOM positions stay in sync.
  useEffect(() => {
    if (!cycle) return
    const upd = () => forceUpdate(n => n + 1)
    window.addEventListener('resize', upd)
    window.addEventListener('scroll', upd, true)
    return () => { window.removeEventListener('resize', upd); window.removeEventListener('scroll', upd, true) }
  }, [!!cycle]) // eslint-disable-line react-hooks/exhaustive-deps

  // Close-animation teardown timer (clears the decoration once the reflow-back has played).
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearCloseTimer = () => { if (closeTimerRef.current !== null) { clearTimeout(closeTimerRef.current); closeTimerRef.current = null } }
  // Last applied compression range — so the close can ramp ITS spans' letter-spacing back to 0
  // (same ranges → the transition fires) rather than dropping them with a snap.
  const lastLineRangeRef = useRef<LineRange | null>(null)

  // ── Shared layout pass (Fix 2): always re-measure the NATURAL line fresh ──────
  // Clear decorations, re-find the live element, measure rect + line-right ANEW, recompute
  // compression, apply. Never reuse coords captured at open time — they go stale after scroll
  // or iOS toolbar resize. Idempotent. When `animate`, apply the START (natural) state, force a
  // reflow, then the END state; the CSS transitions on min-width / letter-spacing (see
  // RedHighlightExtension) ramp between them — browser-driven, smooth on phones.
  function applyLayout(from: number, to: number, minWidth: number, overlay: boolean, animate = false) {
    clearCloseTimer()
    if (overlay) { onHintChange(from, null); return }   // overlay mode never compresses
    onHintChange(null, null)                            // clear so we measure the natural line
    const fe = Array.from(editor.view.dom.querySelectorAll<HTMLElement>('.scas-red'))
      .find(el => posOf(el, editor) === from)
    const pe = fe?.closest('p')
    if (!fe || !pe) return
    const rect         = fe.getBoundingClientRect()
    const naturalWidth = rect.width
    const natRight     = measureNaturalLineRight(rect, pe)
    const lineRange = computeLineCompressionRange(
      rect.top, rect.bottom, natRight, naturalWidth, minWidth, from, to, pe, editor,
    )
    const alignFraction = lineRange?.alignFraction ?? 0
    lastLineRangeRef.current = lineRange
    setCycle(prev => (prev && prev.from === from) ? { ...prev, alignFraction, naturalWidth } : prev)

    if (animate && minWidth > naturalWidth) {
      const flat = lineRange ? { ...lineRange, lsBeforeEm: 0, lsAfterEm: 0 } : null
      const focused = () => editor.view.dom.querySelector('.scas-focused') as HTMLElement | null
      // 1. START at natural, INSTANTLY (transition:none) — so a reused decoration node never
      //    animates from the previous word's reserved (wider) width, the tab-overflow flash.
      onHintChange(from, naturalWidth, flat, false)
      void focused()?.offsetWidth
      // 2. ARM the transition (turn it on) WITHOUT changing the values yet. Toggling
      //    transition none->on AND changing a value in the same step does not reliably start a
      //    transition in every browser; if min-width snaps to full while letter-spacing still
      //    animates, the after-text overflows for a few frames. Splitting the two guarantees
      //    both ramp together.
      onHintChange(from, naturalWidth, flat, true, REFLOW_OPEN_MS)
      void focused()?.offsetWidth
      // 3. END — values change with the transition already armed: min-width + letter-spacing
      //    ramp in lockstep, every time. OPEN is snappy.
      onHintChange(from, minWidth, lineRange, true, REFLOW_OPEN_MS)
    } else {
      onHintChange(from, minWidth, lineRange, false)    // no animation requested → apply instantly
    }
  }

  // Animate the reflow back to natural, then tear the cycle down. Called on dismiss/commit so
  // the surrounding text eases back instead of snapping. `targetWidth` is where the box should
  // settle: the original word's width on dismiss, or the CHOSEN synonym's width on commit — in
  // either case it ramps to the layout the committed/restored text will actually occupy (box at
  // that width, no compression), so the swap at the end is seamless.
  function closeWithAnimation(after?: () => void, targetWidth?: number) {
    clearCloseTimer()
    const c = cycle
    if (!c || c.overlay) { onHintChange(null, null); setCycle(null); after?.(); return }
    // Ramp the box + compression to the target together (CSS transitions animate both): keep
    // the same compression ranges but with letter-spacing 0, so the spans transition rather than
    // vanish. The reel stays up (the chosen word sits at its natural x, which doesn't move).
    const lr = lastLineRangeRef.current

    // FLIP (experimental): record where the after-text starts BEFORE the snap, so we can pull it
    // back there afterwards and ease it home. The focused word's right edge IS the after-run's
    // left edge (they're adjacent), so one measurement captures the whole slide.
    const flip = wantsFlip()
    let beforeRight: number | null = null
    if (flip) {
      const fe = editor.view.dom.querySelector('.scas-focused') as HTMLElement | null
      beforeRight = fe ? fe.getBoundingClientRect().right : null
    }

    // Settle the surrounding text to natural INSTANTLY (no per-frame reflow — the lag). The word
    // itself still slides home smoothly on the compositor (the `committing` transform in
    // ThesaurusPopover), so the part the eye is on glides while the rest just resolves.
    onHintChange(c.from, targetWidth ?? c.naturalWidth, lr ? { ...lr, lsBeforeEm: 0, lsAfterEm: 0 } : null, false)

    // FLIP play: the snap above moved the after-text to its final spot in one reflow. Now measure
    // how far it travelled (the focused word's right edge IS the after-run's left edge), then
    // re-render the after-run inverted (translateX back to where it was, transition off) and — after
    // a forced reflow — at 0 with the transition armed. The run eases home on the compositor with no
    // further layout. Done through the DECORATION (two onHintChange dispatches) so PM keeps the
    // transform; a manual DOM edit is reverted by PM's reconciler within a frame.
    if (flip && beforeRight !== null && lr) {
      const fe = editor.view.dom.querySelector('.scas-focused') as HTMLElement | null
      const pe = fe?.closest('p')
      const afterSpan = pe?.querySelector('.scas-comp-after') as HTMLElement | null
      const dx = fe ? beforeRight - fe.getBoundingClientRect().right : 0
      // Only slide if the de-compressed after-run still sits on ONE line within the right margin.
      // If a longer commit has filled/overflowed the line, making the run display:inline-block (it
      // must be, to carry the transform) would drop the WHOLE atomic run to the next line mid-slide
      // — the end-of-line comma "wrapping away and back", and lower-line words appearing to move.
      // In that case skip the slide entirely: the line just snaps to its rewrapped layout. (The
      // "joining word slides in from the right" treatment is a separate, later step.)
      let fits = true
      if (fe && afterSpan && pe) {
        const ar = afterSpan.getBoundingClientRect()
        const fh = fe.getBoundingClientRect().height || 1
        const paraRight = pe.getBoundingClientRect().right
        fits = ar.height < fh * 1.5 && ar.right <= paraRight + 1   // single line, inside the margin
      }
      if (fe && afterSpan && fits && Math.abs(dx) > 0.5) {
        const flat = { ...lr, lsBeforeEm: 0, lsAfterEm: 0 }
        onHintChange(c.from, targetWidth ?? c.naturalWidth, { ...flat, afterSlidePx: dx }, false)   // invert, instant
        void afterSpan.offsetWidth                                                                  // commit the start
        onHintChange(c.from, targetWidth ?? c.naturalWidth, { ...flat, afterSlidePx: 0 }, true, REFLOW_COMMIT_MS) // play home
      }
    }

    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null
      // Swap FIRST (old word -> committed synonym), THEN clear the decoration + reel — so the
      // original word is never revealed for a frame between the clear and the text swap (a flash).
      after?.()
      onHintChange(null, null)
      setCycle(null)
    }, REFLOW_COMMIT_MS)
  }

  // SWAP-FIRST commit slide. Replace the word NOW (so the paragraph rewraps to its final layout),
  // tear the reel down, then slide the WHOLE after-run — the rest of the committed word's visual
  // line, including any word that just rewrapped up onto it — in from the right as one flush motion.
  // Lines below snap. Because the inline-block run is built on the FINAL (correctly-wrapped) layout
  // it fits its line and never wrap-drops; the translateX is purely visual overflow during the
  // glide. The slide is driven by a decoration independent of the cycle, so it survives teardown.
  function commitWithSlide(swap: () => void, from: number, replacementLen: number) {
    clearCloseTimer()
    // 1. FIRST — the after-run's left edge before the swap = the focused (expanded) box's right.
    const fe0 = editor.view.dom.querySelector('.scas-focused') as HTMLElement | null
    const beforeRight = fe0 ? fe0.getBoundingClientRect().right : null
    // 2. LAST — clear the reel/decoration, swap the text (committed text shows immediately, in place).
    onHintChange(null, null)
    swap()
    setCycle(null)
    if (beforeRight === null) return
    // 3. Measure the committed word + its visual-line end on the FINAL layout.
    const committedTo = from + replacementLen
    const wordEl = Array.from(editor.view.dom.querySelectorAll<HTMLElement>('.scas-red')).find(el => posOf(el, editor) === from)
    const pe = wordEl?.closest('p')
    if (!wordEl || !pe) return
    const wrect = wordEl.getBoundingClientRect()
    const lineEnd = lineEndPosAfter(wrect, committedTo, pe, editor)
    if (lineEnd <= committedTo) return                 // word sits at the line end → nothing to slide
    let dx = beforeRight - wrect.right                 // how far the after-run's left moved (>0 ⇒ in from the right)
    // Don't start the run beyond the right margin: de-compressed it is WIDER than the compressed
    // version that fit on the line during the cycle, so a full-dx invert pushes its right edge past
    // the margin and it "flashes outward" before pulling in. Cap dx so the run enters FROM the
    // margin (right edge at the edge), not from beyond it.
    const finalRight = measureNaturalLineRight(wrect, pe)   // rightmost char on the committed line = the run's right edge
    const paraRight  = pe.getBoundingClientRect().right
    dx = Math.min(dx, Math.max(0, paraRight - finalRight - 1))
    if (Math.abs(dx) < 0.5) return
    // 4. INVERT (instant) → reflow → PLAY to 0, through the slide decoration.
    const slide = { from: committedTo, to: lineEnd, px: dx }
    onHintChange(null, null, null, false, undefined, slide)
    void (editor.view.dom.querySelector('.scas-slide-after') as HTMLElement | null)?.offsetWidth
    onHintChange(null, null, null, true, REFLOW_COMMIT_MS, { ...slide, px: 0 })
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null
      onHintChange(null, null, null, false, undefined, null)   // drop the slide decoration
    }, REFLOW_COMMIT_MS + 40)
  }

  // Expand/compress immediately (no deferral). We tried deferring the pass while a touch was
  // held — to avoid rebuilding the DOM under an active gesture — but with no reserved space
  // during the hold, wide synonyms had nowhere to go (they overlapped, then clipped, the
  // surrounding text). The iOS gesture is instead kept alive by the on-node touchmove
  // suppressor in ThesaurusPopover (Fix 4), which survives the rebuild, so we can apply the
  // layout right away and the reel always has its box.

  // Resize safety net — re-measure & re-apply for the current cycle (idempotent).
  useEffect(() => {
    if (!cycle || cycle.overlay) return
    const c = cycle
    const onResize = () => applyLayout(c.from, c.to, c.minWidth, c.overlay)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [cycle?.from, cycle?.minWidth]) // eslint-disable-line react-hooks/exhaustive-deps

  function openCycleForElement(target: HTMLElement) {
    clearCloseTimer()   // re-opening during a close-animation cancels its pending teardown
    const displayWord = target.textContent ?? ''
    const lookupWord  = target.dataset.word ?? displayWord.toLowerCase()
    if (!lookupWord) return
    const overlay = wantsOverlay()

    let domPos: number
    try { domPos = editor.view.posAtDOM(target.firstChild ?? target, 0) } catch { return }

    // Clear existing decoration synchronously — PM dispatch is sync so the DOM
    // reverts to natural layout before we measure.
    onHintChange(null, null)

    // Re-acquire a live element: the PM rebuild above may have destroyed the
    // original target if the previous compression range covered this word.
    const reds = Array.from(editor.view.dom.querySelectorAll<HTMLElement>('.scas-red'))
    const live = reds.find(el => posOf(el, editor) === domPos)
    if (!live) return

    const rect   = live.getBoundingClientRect()
    const font   = getFont(live)
    const pEl    = live.closest('p')
    const natRight = pEl ? measureNaturalLineRight(rect, pEl) : rect.right

    // Apply provisional focus immediately (instant, no transition) to prevent the null-gap flash
    // on Tab nav and to give the open animation a clean natural starting box.
    onHintChange(domPos, rect.width, null, false)
    setCycle({
      word: lookupWord, from: domPos, to: domPos + displayWord.length,
      synonyms: Array(CYCLE_SIZE).fill(displayWord),
      reelPos: 0, overlay,
      minWidth: rect.width, naturalWidth: rect.width, naturalLeft: rect.left, alignFraction: 0.5,
      naturalTop: rect.top, naturalBottom: rect.bottom, naturalLineRight: natRight,
    })

    getSynonyms(lookupWord).then(candidates => {
      // Bail if the cycle closed or another word was focused while fetching.
      const fe = editor.view.dom.querySelector('.scas-focused') as HTMLElement | null
      if (!fe || posOf(fe, editor) !== domPos) return

      // Slot 0 is the ORIGINAL word (lookupWord = the managed slot's original, or the
      // word itself when unmanaged), so a managed word re-offers the original's list.
      // Match the flagged word's leading case: a capitalised word keeps its capital
      // through every slot (and on commit).
      const capitalize = /^[A-Z]/.test(displayWord)
      const { synonyms, minWidth } = buildSynonyms(lookupWord, candidates, font, rect.width, capitalize)
      // Centre the reel on the word currently in the text (may differ from the original for a
      // managed slot), so reopening shows what's there, not the original.
      const cur = displayWord.toLowerCase()
      let reelPos = synonyms.findIndex(s => s !== DELETE_SENTINEL && s.toLowerCase() === cur)
      if (reelPos < 0) reelPos = 0
      setCycle(prev => prev?.from === domPos ? { ...prev, synonyms, minWidth, reelPos } : prev)
      // Apply the expand+compress layout INSTANTLY (no per-frame reflow animation — that was the
      // lag). The surrounding text settles in one step; the reel's vertical scroll and the
      // commit word-slide stay smooth on the compositor.
      applyLayout(domPos, domPos + displayWord.length, minWidth, overlay, false)
    })
  }

  return { cycle, setCycle, openCycleForElement, closeWithAnimation, commitWithSlide }
}
