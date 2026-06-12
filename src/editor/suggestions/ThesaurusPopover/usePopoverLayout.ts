import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { Editor } from '@tiptap/react'
import { getSynonyms } from '../thesaurus'
import { getFont } from '../textMetrics'
import { CYCLE_SIZE, DELETE_SENTINEL, REFLOW_OPEN_MS, REFLOW_COMMIT_MS } from './popoverConstants'
import type { CycleState, OnHintChange, LineRange, SlideRange } from './popoverConstants'
import { posOf, measureNaturalLineRight, computeLineCompressionRange, lineEndPosAfter } from './popoverGeometry'
import { buildSynonyms } from './popoverFallbacks'
import { lemmaOf } from '../../../scas/engine'

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
  isLockedLemma?: (lemma: string) => boolean,
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

    // FLIP-OPEN (mirror of the commit slide): the box expands and the after-text gets pushed right
    // and compressed. We apply that final layout INSTANTLY (the box is transparent — the reel paints
    // the word — so its own snap isn't seen), then slide the after-run in from where it sat at
    // natural width and ease the COMPRESSION on with scaleX. So the after-text appears to glide OUT
    // to make room rather than teleporting. (min-width can't transition cheaply — that was the lag.)
    if (animate && minWidth > naturalWidth && lineRange) {
      const naturalAfterLeft  = rect.right                      // after-run's left edge at natural width
      const naturalBeforeRight = rect.left                      // before-run's right edge at natural width
      const fsz = parseFloat(window.getComputedStyle(fe).fontSize) || 18
      onHintChange(from, minWidth, lineRange, false)            // apply expanded + compressed layout instantly
      const compA = editor.view.dom.querySelector('.scas-comp-after')  as HTMLElement | null
      const compB = editor.view.dom.querySelector('.scas-comp-before') as HTMLElement | null
      const inv:  LineRange = { ...lineRange }
      const play: LineRange = { ...lineRange }
      let anyAnim = false
      // AFTER run (origin-left): slid right + compressed. scaleStart from the COMPRESSION AMOUNT
      // (lsAfterEm·fsz·chars), NOT a width ratio — a ratio breaks when the line rewraps on open.
      if (compA && to < lineRange.to) {
        const dx    = compA.getBoundingClientRect().left - naturalAfterLeft  // >0: after-run pushed right
        const compW = Math.max(1, compA.getBoundingClientRect().width)
        const chars = Math.max(1, lineRange.to - to)
        const decompress = (lineRange.lsAfterEm || 0) * fsz * chars
        const scaleStart = Math.max(1, Math.min(1.5, (compW + decompress) / compW))
        if (Math.abs(dx) > 0.5 || scaleStart > 1.01) {
          inv.afterSlidePx = -dx; inv.afterScaleX = scaleStart; play.afterSlidePx = 0; play.afterScaleX = 1; anyAnim = true
        }
      }
      // BEFORE run (origin-right, glued to the fixed word): its right edge slid LEFT (the box centred
      // itself) and it compressed. Restore it to natural at start (slide right by the shift, scale to
      // natural width) and ease home — so the LHS animates instead of snapping (the "static flash").
      if (compB && lineRange.firstWordEnd < from) {
        const bShift = naturalBeforeRight - compB.getBoundingClientRect().right  // >0: before-right moved left
        const compWb = Math.max(1, compB.getBoundingClientRect().width)
        const charsB = Math.max(1, from - lineRange.firstWordEnd)
        const decompressB = (lineRange.lsBeforeEm || 0) * fsz * charsB
        const bScaleStart = Math.max(1, Math.min(1.5, (compWb + decompressB) / compWb))
        if (Math.abs(bShift) > 0.5 || bScaleStart > 1.01) {
          inv.beforeSlidePx = bShift; inv.beforeScaleX = bScaleStart; play.beforeSlidePx = 0; play.beforeScaleX = 1; anyAnim = true
        }
      }
      if (anyAnim) {
        onHintChange(from, minWidth, inv, false)                                          // invert, instant
        void (editor.view.dom.querySelector('.scas-comp-after, .scas-comp-before') as HTMLElement | null)?.offsetWidth
        onHintChange(from, minWidth, play, true, REFLOW_OPEN_MS)                           // play home
        return
      }
    }
    onHintChange(from, minWidth, lineRange, false)    // no animation (or nothing to slide) → instant
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
    let afterRight0: number | null = null      // focused word's right edge (= after-run's left) BEFORE the snap
    let beforeWordLeft0: number | null = null  // focused word's left edge (= before-run's right) BEFORE the snap
    if (flip) {
      const fe = editor.view.dom.querySelector('.scas-focused') as HTMLElement | null
      if (fe) { const r = fe.getBoundingClientRect(); afterRight0 = r.right; beforeWordLeft0 = r.left }
    }

    // Settle the surrounding text to natural INSTANTLY (no per-frame reflow — the lag). The word
    // itself still slides home smoothly on the compositor (the `committing` transform in
    // ThesaurusPopover), so the part the eye is on glides while the rest just resolves.
    onHintChange(c.from, targetWidth ?? c.naturalWidth, lr ? { ...lr, lsBeforeEm: 0, lsAfterEm: 0 } : null, false)

    // FLIP play: the snap above moved BOTH runs to their natural spots in one reflow. Re-render each
    // run inverted to where it sat while open (offset + compressed via scaleX), then — after a forced
    // reflow — at identity with the transition armed, so both ease home on the compositor AND the
    // de-compression animates (no one-frame widening = no "flash backwards", no LHS "static flash").
    // Driven through the DECORATION so PM keeps the transform (a manual DOM edit is reverted).
    if (flip && lr) {
      const fe = editor.view.dom.querySelector('.scas-focused') as HTMLElement | null
      const pe = fe?.closest('p')
      const afterSpan  = pe?.querySelector('.scas-comp-after')  as HTMLElement | null
      const beforeSpan = pe?.querySelector('.scas-comp-before') as HTMLElement | null
      const fsz = fe ? (parseFloat(getComputedStyle(fe).fontSize) || 18) : 18
      const inv:  Partial<LineRange> = { lsBeforeEm: 0, lsAfterEm: 0 }
      const play: Partial<LineRange> = { lsBeforeEm: 0, lsAfterEm: 0 }
      let anyAnim = false
      // AFTER run recedes LEFT + de-compresses. Only if it still sits on ONE line inside the margin —
      // else making it inline-block would wrap-drop the whole run to the next line mid-slide (the
      // end-of-line comma "wrapping away and back", lower lines appearing to move).
      if (fe && afterSpan && pe && afterRight0 !== null) {
        const ar = afterSpan.getBoundingClientRect()
        const fh = fe.getBoundingClientRect().height || 1
        const fits = ar.height < fh * 1.5 && ar.right <= pe.getBoundingClientRect().right + 1
        const dx = afterRight0 - fe.getBoundingClientRect().right   // >0: after-run was further right
        if (fits && Math.abs(dx) > 0.5) {
          const W = Math.max(1, ar.width)
          const decompress = (lr.lsAfterEm || 0) * fsz * Math.max(1, lr.to - c.to)
          inv.afterSlidePx = dx;  inv.afterScaleX = Math.max(0.5, Math.min(1, (W - decompress) / W))
          play.afterSlidePx = 0;  play.afterScaleX = 1
          anyAnim = true
        }
      }
      // BEFORE run de-compresses back (origin-right): its right edge moves RIGHT to the word's natural
      // left. Invert puts it at the compressed (leftward) position + compressed width, then eases home.
      if (fe && beforeSpan && beforeWordLeft0 !== null && lr.firstWordEnd < c.from) {
        const bdx = beforeWordLeft0 - fe.getBoundingClientRect().left   // <0: before-right was further left
        const Wb = Math.max(1, beforeSpan.getBoundingClientRect().width)
        const decompressB = (lr.lsBeforeEm || 0) * fsz * Math.max(1, c.from - lr.firstWordEnd)
        const bScaleStart = Math.max(0.5, Math.min(1, (Wb - decompressB) / Wb))
        if (Math.abs(bdx) > 0.5 || bScaleStart < 0.99) {
          inv.beforeSlidePx = bdx;  inv.beforeScaleX = bScaleStart
          play.beforeSlidePx = 0;   play.beforeScaleX = 1
          anyAnim = true
        }
      }
      if (anyAnim) {
        const w = targetWidth ?? c.naturalWidth
        onHintChange(c.from, w, { ...lr, ...inv } as LineRange, false)   // invert, instant
        void (editor.view.dom.querySelector('.scas-comp-after, .scas-comp-before') as HTMLElement | null)?.offsetWidth
        onHintChange(c.from, w, { ...lr, ...play } as LineRange, true, REFLOW_COMMIT_MS)  // play home
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
    const lr = lastLineRangeRef.current   // the open's compression — for the de-compress scale
    // 1. FIRST — the focused (expanded) box's edges: right = after-run's left, left = before-run's right.
    const fe0 = editor.view.dom.querySelector('.scas-focused') as HTMLElement | null
    const r0 = fe0 ? fe0.getBoundingClientRect() : null
    const beforeRight = r0 ? r0.right : null
    const beforeLeft  = r0 ? r0.left  : null
    // 2. LAST — clear the reel/decoration, swap the text (committed text shows immediately, in place).
    onHintChange(null, null)
    swap()
    setCycle(null)
    if (r0 === null) return
    // 3. Measure the committed word on the FINAL (rewrapped) layout.
    const committedTo = from + replacementLen
    const wordEl = Array.from(editor.view.dom.querySelectorAll<HTMLElement>('.scas-red')).find(el => posOf(el, editor) === from)
    const pe = wordEl?.closest('p')
    if (!wordEl || !pe) return
    const wrect = wordEl.getBoundingClientRect()
    const fsz = parseFloat(getComputedStyle(wordEl).fontSize) || 18

    // AFTER-run slide: the rest of the committed word's visual line slides in from the right and
    // de-compresses (scaleX origin-left) — start at the COMPRESSED width so it doesn't "extend out".
    let invA:  SlideRange | null = null
    let playA: SlideRange | null = null
    if (beforeRight !== null) {
      const lineEnd = lineEndPosAfter(wrect, committedTo, pe, editor)
      const dx = beforeRight - wrect.right
      if (lineEnd > committedTo && Math.abs(dx) >= 0.5) {
        const W = measureNaturalLineRight(wrect, pe) - wrect.right
        const chars = Math.max(1, editor.state.doc.textBetween(committedTo, lineEnd).length)
        const decompress = (lr?.lsAfterEm ?? 0) * fsz * chars
        const scaleStart = W > 0 ? Math.max(0.5, Math.min(1, (W - decompress) / W)) : 1
        invA  = { from: committedTo, to: lineEnd, px: dx, scaleX: scaleStart }
        playA = { from: committedTo, to: lineEnd, px: 0,  scaleX: 1 }
      }
    }

    // BEFORE-run slide: the line's text before the committed word de-compresses back to natural
    // (origin-right, glued to the word) — so the LHS animates on commit instead of snapping.
    let invB:  SlideRange['before'] = undefined
    let playB: SlideRange['before'] = undefined
    if (beforeLeft !== null && lr && lr.firstWordEnd < from) {
      try {
        const naturalWb = editor.view.coordsAtPos(from).left - editor.view.coordsAtPos(lr.firstWordEnd).left
        const bdx = beforeLeft - wrect.left   // how far the before-run's right edge moved (sign = direction)
        if (naturalWb > 1 && Math.abs(bdx) >= 0.5) {
          const charsB = Math.max(1, from - lr.firstWordEnd)
          const decompressB = (lr.lsBeforeEm ?? 0) * fsz * charsB
          const bScaleStart = Math.max(0.5, Math.min(1, (naturalWb - decompressB) / naturalWb))
          invB  = { from: lr.firstWordEnd, to: from, px: bdx, scaleX: bScaleStart }
          playB = { from: lr.firstWordEnd, to: from, px: 0,   scaleX: 1 }
        }
      } catch { /* coordsAtPos can throw on edge positions — skip the before-run */ }
    }

    if (!invA && !invB) return
    const zero: SlideRange = { from: 0, to: 0, px: 0 }   // empty after-run (render skips to===from)
    // 4. INVERT (instant) → reflow → PLAY home, through the slide decoration(s).
    onHintChange(null, null, null, false, undefined, { ...(invA ?? zero), before: invB })
    void (editor.view.dom.querySelector('.scas-slide-after, .scas-slide-before') as HTMLElement | null)?.offsetWidth
    onHintChange(null, null, null, true, REFLOW_COMMIT_MS, { ...(playA ?? zero), before: playB })
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
    // The focus above made the word transparent SYNCHRONOUSLY (PM); the reel is React state. Because
    // this runs in a NATIVE pointerdown listener (not a React synthetic event), React would not
    // guarantee the reel mounts before the browser's next paint — leaving a frame of "transparent
    // word, no reel" = the word VANISHES then reappears. flushSync commits the reel in the same
    // paint as the transparency, closing that gap.
    flushSync(() => setCycle({
      word: lookupWord, from: domPos, to: domPos + displayWord.length,
      synonyms: Array(CYCLE_SIZE).fill(displayWord),
      reelPos: 0, overlay,
      minWidth: rect.width, naturalWidth: rect.width, naturalLeft: rect.left, alignFraction: 0.5,
      naturalTop: rect.top, naturalBottom: rect.bottom, naturalLineRight: natRight,
    }))

    getSynonyms(lookupWord).then(candidates => {
      // Bail if the cycle closed or another word was focused while fetching.
      const fe = editor.view.dom.querySelector('.scas-focused') as HTMLElement | null
      if (!fe || posOf(fe, editor) !== domPos) return

      // Suppress Locked lemmas from the suggestion list (§4.4): a word with an outstanding
      // ban-credit debt can't be acquired cheaply as someone else's synonym.
      const offered = isLockedLemma ? candidates.filter(c => !isLockedLemma(lemmaOf(c))) : candidates

      // Slot 0 is the ORIGINAL word (lookupWord = the managed slot's original, or the
      // word itself when unmanaged), so a managed word re-offers the original's list.
      // Match the flagged word's leading case: a capitalised word keeps its capital
      // through every slot (and on commit).
      const capitalize = /^[A-Z]/.test(displayWord)
      const { synonyms, minWidth } = buildSynonyms(lookupWord, offered, font, rect.width, capitalize)
      // Centre the reel on the word currently in the text (may differ from the original for a
      // managed slot), so reopening shows what's there, not the original.
      const cur = displayWord.toLowerCase()
      let reelPos = synonyms.findIndex(s => s !== DELETE_SENTINEL && s.toLowerCase() === cur)
      if (reelPos < 0) reelPos = 0
      setCycle(prev => prev?.from === domPos ? { ...prev, synonyms, minWidth, reelPos } : prev)
      // Animate the OPEN (FLIP-out): the box expands and the after-text glides out to make room
      // (compositor transform — no per-frame layout), mirroring the commit's inward slide.
      applyLayout(domPos, domPos + displayWord.length, minWidth, overlay, true)
    })
  }

  return { cycle, setCycle, openCycleForElement, closeWithAnimation, commitWithSlide }
}
