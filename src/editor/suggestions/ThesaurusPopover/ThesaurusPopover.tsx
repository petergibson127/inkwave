// ThesaurusPopover — Word-cycle synonym interface.
// Keyboard: j/k cycle, Space accept+advance, Tab prev word, Shift+Tab next, Esc dismiss
// Slots: 0 = original word, 1–7 = synonyms (no delete slot — double-tap a word to delete it)
// Click/touch: opens cycle; drag spins the reel and it rests; short click commits,
// press-and-hold (anywhere) keeps it open to keep changing; double-tap selects for deletion.
//
// Stage D animation model: the reel is a CONTINUOUS scroll position (cycle.reelPos,
// in slot units) rather than discrete steps. A drag moves it 1:1 with the pointer; on
// release a single rAF physics loop coasts with the release velocity (exponential
// decay) and then eases to the nearest slot — Apple-picker momentum, not snapping.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { useCompliance } from '../../../scas/compliance'
import { CYCLE_SIZE, REFLOW_COMMIT_MS, REFLOW_EASE } from './popoverConstants'
import type { OnHintChange } from './popoverConstants'
import { posOf } from './popoverGeometry'
import { displayFor } from './popoverFallbacks'
import { measureTextWidth, getFont } from '../textMetrics'
import { usePopoverLayout } from './usePopoverLayout'

// The selected slot for a given continuous position = nearest ring, wrapped into [0,SIZE).
const slotAt = (pos: number) => ((Math.round(pos) % CYCLE_SIZE) + CYCLE_SIZE) % CYCLE_SIZE

// ── Momentum tuning ──────────────────────────────────────────────────────────
const MAX_VEL    = 0.060   // slots/ms — capped so a frame never jumps the whole window
const FLING_TAU  = 260     // ms; coast distance ≈ v0 · TAU, so larger = more glide / browse
const VEL_STOP   = 0.0006  // slots/ms; below this the fling hands off to the settle ease
const COMMIT_VEL = 0.015   // slots/ms; release slower than this commits, faster coasts (click to accept)

interface ThesaurusPopoverProps {
  editor: Editor
  paragraphIndex: number
  containerEl: React.RefObject<HTMLDivElement>
  onHintChange: OnHintChange
  onCycleChange: (active: boolean) => void
  isLockedLemma?: (lemma: string) => boolean
}

export function ThesaurusPopover({ editor, paragraphIndex, containerEl, onHintChange, onCycleChange, isLockedLemma }: ThesaurusPopoverProps) {
  const { recordAccepted, recordIgnored } = useCompliance()
  const tabCursorRef = useRef<number | null>(null)
  const { cycle, setCycle, openCycleForElement, closeWithAnimation, commitWithSlide } = usePopoverLayout(editor, onHintChange, isLockedLemma)

  // Bump on scroll/resize so the memoised geometry recomputes; reel animation does NOT
  // touch this, so per-frame reelPos updates never redo getBoundingClientRect.
  const [geomNonce, setGeomNonce] = useState(0)
  // True during a commit: the chosen reel synonym slides from its (possibly shifted-left) reel
  // position to its committed natural-x over REFLOW_COMMIT_MS, in sync with the decoration's
  // left/right de-compression — so the word slides home WITH the surrounding text, not after it.
  const [committing, setCommitting] = useState(false)

  useEffect(() => { onCycleChange(!!cycle); if (!cycle) setCommitting(false) }, [!!cycle]) // eslint-disable-line react-hooks/exhaustive-deps

  const redWords = () => Array.from(editor.view.dom.querySelectorAll<HTMLElement>('.scas-red'))

  // ── Reel animation state (refs — authoritative; cycle.reelPos mirrors for render) ──
  const reelRef   = useRef(0)              // live continuous position
  const velRef    = useRef(0)              // slots/ms, for momentum
  const targetRef = useRef(0)              // intended landing slot (keyboard/settle)
  const rafRef    = useRef<number | null>(null)
  const rowHRef   = useRef(20)             // current row height in px (from geometry)
  const engagedRef = useRef(false)         // has the reel reached a non-original slot this session?
  const openedByPointerRef = useRef(false) // did the in-flight press just open the cycle? (don't commit on its release)
  const draggingRef = useRef(false)        // pointer is held down and steering the reel

  // True while the reel is actually scrolling — drives the "original" marker, which
  // only shows in motion. Set on every reel frame; a short idle timer clears it.
  const [moving, setMoving] = useState(false)
  const movingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function cancelAnim() {
    if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
  }
  // Turn the "moving" flag off once the reel is genuinely at rest — but NOT while a drag
  // is held (even paused/stationary) or an animation is running, so a slow drag never
  // blinks the marker off between pointer-move events.
  // Linger longer than a deliberate key-tap cadence so cycling j/k doesn't drop `moving` between
  // presses (which made the neighbour rows fade then snap back — the strobe). 300ms covers taps;
  // held key-repeat is far faster and stays continuously lit.
  function scheduleMovingOff(delay = 300) {
    if (movingTimerRef.current) clearTimeout(movingTimerRef.current)
    movingTimerRef.current = setTimeout(() => {
      if (!draggingRef.current && rafRef.current === null) setMoving(false)
    }, delay)
  }
  function pushReel() {
    if (!engagedRef.current && Math.round(reelRef.current) !== 0) engagedRef.current = true
    setMoving(true)
    scheduleMovingOff()
    setCycle(c => c ? { ...c, reelPos: reelRef.current } : c)
  }

  // ── Cursor management ─────────────────────────────────────────────────────

  function restoreCursor() {
    const pos = tabCursorRef.current; if (pos === null) return
    tabCursorRef.current = null
    requestAnimationFrame(() => { if (!editor.isDestroyed) editor.chain().focus().setTextSelection(pos).run() })
  }
  function pinCursor() {
    if (tabCursorRef.current !== null && !editor.isDestroyed)
      editor.commands.setTextSelection(tabCursorRef.current)
  }
  function closeCycle(record = true, restore = true) {
    if (record) recordIgnored()
    // Ease the reflow back to natural, then tear down (restoreCursor runs after the animation).
    closeWithAnimation(restore ? restoreCursor : undefined)
  }

  // ── Navigation ────────────────────────────────────────────────────────────

  function goNext(after: number, max?: number): boolean {
    const el = redWords().find(el => { const p = posOf(el, editor); return p > after && (max === undefined || p < max) })
    if (el) { openCycleForElement(el); return true }; return false
  }
  function goPrev(before: number): boolean {
    const el = [...redWords()].reverse().find(el => posOf(el, editor) < before)
    if (el) { openCycleForElement(el); return true }; return false
  }

  // ── Accept ────────────────────────────────────────────────────────────────

  function advanceOrRestore(from: number, advance: boolean) {
    if (advance) requestAnimationFrame(() => { if (!goNext(from, tabCursorRef.current ?? undefined)) restoreCursor() })
    else restoreCursor()
  }
  function acceptSuggestion(replacement: string, advance: boolean) {
    if (!cycle) return
    cancelAnim()
    const { from, to, word } = cycle; const wl = to - from
    const changed = replacement !== editor.state.doc.textBetween(from, to)
    recordAccepted()
    const swap = () => {
      if (changed) {
        if (tabCursorRef.current !== null && from < tabCursorRef.current) tabCursorRef.current += replacement.length - wl
        // Carry the SCAS-slot mark (anchored to this slot's original word) so the position
        // stays managed: it keeps rendering red/changeable even if the new word is in vocab,
        // and reopening re-offers the original's synonym list. `word` holds the original.
        editor.chain().deleteRange({ from, to }).insertContentAt(from, {
          type: 'text', text: replacement,
          marks: [{ type: 'scasSlot', attrs: { original: word } }],
        }).run()
      }
      pinCursor(); advanceOrRestore(from, advance)
    }
    // Committing the word UNCHANGED (e.g. opened, scrolled away and back, then accepted) — no edit,
    // but still ease the line back to natural instead of snapping (closeWithAnimation runs the same
    // de-compress as a dismiss; swap() here only restores the caret). Was an instant snap before.
    if (!changed) { closeWithAnimation(swap); return }
    // SWAP-FIRST: replace the word now (paragraph rewraps to its final layout), tear the reel down,
    // then slide the rest of the committed line — including any word that rewrapped up — in from the
    // right as one flush motion; lines below snap. (See commitWithSlide.)
    commitWithSlide(swap, from, replacement.length)
  }

  // Refs so the once-subscribed input handlers below read live state without
  // re-subscribing (which would reset the drag/wheel accumulators).
  const cycleRef = useRef(cycle)
  cycleRef.current = cycle
  const acceptRef = useRef(acceptSuggestion)
  acceptRef.current = acceptSuggestion

  // ── Reel motion ─────────────────────────────────────────────────────────────

  function acceptLanded(pos: number, advance: boolean) {
    const c = cycleRef.current; if (!c) return
    acceptRef.current(c.synonyms[slotAt(pos)], advance)
  }

  // Commit whatever slot the reel has come to rest on. A tap/rest on the ORIGINAL word (even
  // un-scrolled) now CONFIRMS it (records it as a deliberate choice and eases shut) rather than
  // dismissing — dropping the old "you must scroll the word around to confirm" requirement.
  // Dismiss is still available via Escape / Tab-away / tapping outside the reel.
  function commitLandedRest() {
    const c = cycleRef.current; if (!c) return
    acceptRef.current(c.synonyms[slotAt(reelRef.current)], false)
  }

  // Ease reelPos to an integer slot. `onRest` fires once it lands — fling passes the commit so a
  // released flick auto-accepts; keyboard/wheel settles pass nothing and just rest.
  function settleTo(target: number, onRest?: () => void) {
    cancelAnim()
    targetRef.current = target
    const start = reelRef.current
    const dist  = target - start
    if (Math.abs(dist) < 0.001) { reelRef.current = target; pushReel(); onRest?.(); return }
    const dur = Math.min(280, 130 + Math.abs(dist) * 90)
    let t0: number | null = null
    const step = (t: number) => {
      if (t0 === null) t0 = t
      const p = Math.min(1, (t - t0) / dur)
      const e = 1 - Math.pow(1 - p, 3)            // easeOutCubic
      reelRef.current = start + dist * e
      pushReel()
      if (p < 1) { rafRef.current = requestAnimationFrame(step) }
      else { rafRef.current = null; reelRef.current = target; pushReel(); onRest?.() }
    }
    rafRef.current = requestAnimationFrame(step)
  }

  // Coast with the release velocity, decaying exponentially, then settle on the nearest slot and
  // COMMIT it — a released flick lands and accepts once its momentum runs out (no second tap).
  function fling(v0: number) {
    cancelAnim()
    velRef.current = Math.max(-MAX_VEL, Math.min(MAX_VEL, v0))
    let last: number | null = null
    const step = (t: number) => {
      if (last === null) last = t
      let dt = t - last; last = t
      if (dt > 50) dt = 50                         // clamp tab-switch / GC stalls
      reelRef.current += velRef.current * dt
      velRef.current  *= Math.exp(-dt / FLING_TAU)
      pushReel()
      if (Math.abs(velRef.current) < VEL_STOP) { rafRef.current = null; settleTo(Math.round(reelRef.current), commitLandedRest) }
      else rafRef.current = requestAnimationFrame(step)
    }
    rafRef.current = requestAnimationFrame(step)
  }

  // Keyboard j/k: glide one slot, chaining off the pending target if mid-animation.
  function nudge(dir: number) {
    const base = rafRef.current !== null ? targetRef.current : Math.round(reelRef.current)
    settleTo(base + dir)
  }

  // ── Open (pointer) / focus reset ─────────────────────────────────────────────

  useEffect(() => {
    if (!editor) return
    const edEl = editor.view.dom
    function onPointerDown(e: PointerEvent) {
      const t = (e.target as HTMLElement).closest('.scas-red') as HTMLElement | null
      if (!t || !edEl.contains(t)) return
      e.preventDefault(); tabCursorRef.current = null
      openedByPointerRef.current = true   // this press opens a cycle — its release must not commit
      // Fix 4: opening rebuilds this .scas-red span (PM dispatch), and WebKit keeps sending the
      // gesture's touch events to the now-DETACHED node — which has no ancestors, so the
      // document-level touchmove handler never sees them and iOS starts scrolling. CSS
      // touch-action can't help (inert on display:inline, read only at gesture start). So
      // attach a non-passive touchmove listener to the touched node ITSELF, before the rebuild;
      // a detached node still receives its own gesture's events, so preventDefault keeps working.
      if (e.pointerType === 'touch') {
        const suppress = (ev: TouchEvent) => ev.preventDefault()
        const cleanup = () => {
          t.removeEventListener('touchmove', suppress)
          t.removeEventListener('touchend', cleanup)
          t.removeEventListener('touchcancel', cleanup)
        }
        t.addEventListener('touchmove', suppress, { passive: false })
        t.addEventListener('touchend', cleanup)
        t.addEventListener('touchcancel', cleanup)
      }
      openCycleForElement(t)
      // The open REBUILDS this .scas-red span (PM dispatch destroys it). The browser gives the
      // pointer an IMPLICIT capture to that span — but per spec it's set AFTER the pointerdown event
      // finishes dispatching, so a setPointerCapture() we call *synchronously* here gets clobbered by
      // it on some words (whichever way the per-word rebuild timing falls) → once that span detaches,
      // the gesture's pointermove/up bubble up an orphaned tree and never reach the document reel-drag
      // listener = "every second word won't scroll on first click". So re-assert capture on the editor
      // root (never rebuilt) in a MICROTASK too: that runs after dispatch (after the implicit capture
      // is set) but before the next pointer event, reliably overriding it. Belt-and-braces: both.
      const pid = e.pointerId
      const grab = () => { try { edEl.setPointerCapture(pid) } catch { /* pointer ended */ } }
      grab()
      queueMicrotask(grab)
    }
    document.addEventListener('pointerdown', onPointerDown, { capture: true })
    return () => document.removeEventListener('pointerdown', onPointerDown, { capture: true })
  }, [editor]) // eslint-disable-line react-hooks/exhaustive-deps

  // Reset the reel whenever a different word is focused (or the cycle opens/closes).
  // Keyed on `from` only — synonym loads (which keep `from`) must not reset position.
  // Also keyed on cycle.synonyms: when the real synonym list loads it carries the
  // reel position centred on the current word, so resync reelRef to it then.
  useEffect(() => {
    // Synonyms resolving mid-drag re-run this (cycle.synonyms changed). Don't reset reelRef under
    // the user's finger — that snapped the reel back and made the FIRST drag on a cold-cache word
    // (i.e. the original dark-purple word, whose synonyms aren't cached yet) feel dead, requiring a
    // second drag. While a drag is live, leave the reel alone.
    if (draggingRef.current && cycle) { setMoving(true); scheduleMovingOff(650); return }
    cancelAnim()
    velRef.current = 0
    engagedRef.current = false
    reelRef.current = cycle ? cycle.reelPos : 0
    targetRef.current = cycle ? Math.round(cycle.reelPos) : 0
    // Reveal the neighbour rows ONCE, only when the REAL synonyms land — so the writer can see
    // there are alternatives to scroll to. The flicker came from firing this on BOTH the placeholder
    // open (synonyms = [word,word,…], all identical) AND the real-synonym load: two reveal+fade
    // cycles read as a flash. The placeholder has no variety (Set size 1), so it's skipped; only the
    // real list (size > 1) lights the rows, then they linger and fade to the calm centre-only rest.
    if (cycle && new Set(cycle.synonyms).size > 1) { setMoving(true); scheduleMovingOff(900) }
    else if (!cycle) { if (movingTimerRef.current) clearTimeout(movingTimerRef.current); setMoving(false) }
  }, [cycle?.from, cycle?.synonyms]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Keyboard ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!editor) return
    function onKeyDown(e: KeyboardEvent) {
      if (cycle) {
        e.stopPropagation()
        if (e.key === 'Escape') { e.preventDefault(); cancelAnim(); closeCycle(); return }
        if (e.key === 'j') { e.preventDefault(); nudge(-1); return }
        if (e.key === 'k') { e.preventDefault(); nudge(+1); return }
        if (e.key === 'Tab') {
          e.preventDefault(); recordIgnored()
          const found = e.shiftKey ? goNext(cycle.from) : goPrev(cycle.from)
          if (!found) { onHintChange(null, null); setCycle(null); restoreCursor() }
          return
        }
        if (e.key === ' ') {
          e.preventDefault()
          const sel = rafRef.current !== null ? targetRef.current : reelRef.current
          acceptSuggestion(cycle.synonyms[slotAt(sel)], true)
          return
        }
        if (e.key === 'Enter') { e.preventDefault(); return }
        e.preventDefault(); return
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        if (tabCursorRef.current === null) tabCursorRef.current = editor.state.selection.from
        const cur = editor.state.selection.from
        if (e.shiftKey) {
          const reds = redWords()
          const t = reds.find(el => parseInt(el.dataset.para ?? '0', 10) === paragraphIndex && posOf(el, editor) >= cur)
               ?? reds.find(el => posOf(el, editor) > cur)
          if (t) openCycleForElement(t); else tabCursorRef.current = null
        } else {
          const prev = [...redWords()].reverse().find(el => posOf(el, editor) < cur)
          if (prev) openCycleForElement(prev); else tabCursorRef.current = null
        }
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [editor, cycle, paragraphIndex]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Pointer / wheel input ─────────────────────────────────────────────────────
  // Subscribed once (deps: [editor]); reads live state via refs so the drag/wheel
  // accumulators survive the per-frame setCycle updates the animation fires.
  useEffect(() => {
    if (!editor) return
    const edEl = editor.view.dom

    const overTarget = (t: EventTarget | null) => {
      const el = t as HTMLElement | null
      return !!el && (edEl.contains(el) || !!el.closest?.('.scas-cycle-card'))
    }

    // Trackpad/wheel reel-scrolling is DISABLED (per request): the reel is driven by press-drag and
    // the keyboard (j/k) only. Wheel events pass through, so the page scrolls normally (the popover
    // follows the word via the scroll handler). The physical wheel stays free for the anti-cheat gate.
    function onWheel() { /* no-op — trackpad/wheel reel scroll turned off */ }

    // Right-click accepts the centred word and advances (same as Space).
    function onContextMenu(e: MouseEvent) {
      if (!cycleRef.current || !overTarget(e.target)) return
      e.preventDefault()
      acceptLanded(reelRef.current, true)
    }

    // Select a word's range so it can be deleted — the only delete path now that the ⌫
    // slot is gone. Triggered by a double-tap (detected in onPointerUp; the browser never
    // fires a native dblclick because opening the cycle rebuilds the word's DOM node).
    function selectWordForDeletion(from: number, wordTo: number) {
      cancelAnim(); openedByPointerRef.current = false
      closeCycle(false, false)   // dismiss without committing or restoring a caret
      // The open-cycle effect put user-select:none on the editor; its async cleanup may
      // not have run yet, so restore it now or the programmatic selection won't render.
      edEl.style.userSelect = ''
      edEl.style.removeProperty('-webkit-user-select')
      requestAnimationFrame(() => {
        if (!editor.isDestroyed) editor.chain().focus().setTextSelection({ from, to: wordTo }).run()
      })
    }

    // Press + drag up/down spins the reel 1:1 with the pointer (one row-height = one
    // slot). Works for both mouse (button held) and touch (finger down) — we track
    // clientY deltas ourselves rather than movementY, which mobile browsers report
    // unreliably on touch pointers. Releasing flings with the gathered velocity and
    // the reel RESTS.
    //
    // Commit model: a STILL click (no scroll, any duration) commits the rested word. A press-and-
    // DRAG spins the reel; releasing a drag commits the landed word (or flings). Duration no longer
    // matters — only whether the pointer moved — so a slow deliberate tap still confirms.
    const TAP_PX = 6                                 // pointer travel under this = a still click (commit)
    let lastY: number | null = null
    let lastT = 0
    let downX = 0, downY = 0
    let dragArmed = false   // only a press that STARTS on the word/reel may drag-scroll it
    let pointerIsDown = false  // OUR own down-tracking — touch/pen pointermove reports buttons:0 (a
                               // finger isn't a "button"), so we can't trust e.buttons there.
    let lastTapTime = 0, lastTapX = 0, lastTapY = 0   // for manual double-tap detection
    let pushScheduled = false
    function schedulePush() {
      if (pushScheduled) return
      pushScheduled = true
      requestAnimationFrame(() => { pushScheduled = false; pushReel() })
    }
    function onPointerDown(e: PointerEvent) {
      pointerIsDown = true
      downX = e.clientX; downY = e.clientY
      lastY = null                                   // a drag begins on the first move
      // Arm the drag-to-scroll only if the press lands on the word or the reel — a drag that
      // begins on empty parchment / body text must NOT spin the reel.
      const el = e.target as HTMLElement | null
      // Arm the drag-to-scroll if the press lands on the word/reel — OR if it just OPENED a cycle.
      // The opening press is, by definition, on a red word; but the capture-phase open handler (which
      // runs before this) rebuilds the DOM and applies compression, so a real hit-test can resolve
      // e.target to a sibling `.scas-comp-before/after` span (no matching class) → dragArmed went
      // false → the opening press couldn't scroll the reel. openedByPointerRef (set by that handler)
      // tells us this press opened a cycle, so arm it unconditionally.
      dragArmed = openedByPointerRef.current || !!el?.closest?.('.scas-red, .scas-cycle-card')
    }
    function onPointerMove(e: PointerEvent) {
      // Mouse: trust e.buttons (catches button-released-without-pointerup). Touch/pen: that bit is
      // unreliably 0 during a drag, so use our own down-tracking instead — otherwise the FIRST
      // press-drag on a phone froze the reel (it reported buttons:0 and bailed every move).
      const held = e.pointerType === 'mouse' ? (e.buttons & 1) : pointerIsDown
      if (!held || !cycleRef.current || !dragArmed) { lastY = null; draggingRef.current = false; return }
      if (lastY === null) {                          // drag begins — grab any in-flight momentum
        cancelAnim()
        lastY = e.clientY; lastT = e.timeStamp; velRef.current = 0
        draggingRef.current = true; setMoving(true)   // held + steering: keep the marker lit
        return
      }
      const rowH = rowHRef.current || 1
      const dPos = -(e.clientY - lastY) / rowH       // finger up → reel advances (k)
      lastY = e.clientY
      reelRef.current += dPos
      const dt = Math.max(1, e.timeStamp - lastT); lastT = e.timeStamp
      velRef.current = velRef.current * 0.6 + (dPos / dt) * 0.4   // smoothed slots/ms
      schedulePush()
    }
    // Commit the word the reel is resting on. Resting on the original (even un-scrolled) now
    // CONFIRMS it rather than dismissing — see commitLandedRest. Dismiss = Escape / Tab / outside tap.
    function commitRested() {
      const c = cycleRef.current; if (!c) return
      acceptRef.current(c.synonyms[slotAt(reelRef.current)], false)
    }
    function onPointerUp(e: PointerEvent) {
      pointerIsDown = false
      const wasDragging = lastY !== null
      lastY = null
      draggingRef.current = false
      if (wasDragging) scheduleMovingOff()   // released a drag: fade once the reel rests
      const opened = openedByPointerRef.current
      openedByPointerRef.current = false
      const c = cycleRef.current
      const dist = Math.hypot(e.clientX - downX, e.clientY - downY)
      // A still release (no scroll) is a click → confirm, regardless of how long it was held. The
      // old `< TAP_MS` (250ms) gate meant a slow, deliberate tap fell through BOTH the tap and drag
      // branches and did nothing — so you had to nudge a pixel (which made it a drag) to commit.
      if (dist < TAP_PX) {
        // Double-tap (two quick taps near each other) on the open word selects it for
        // deletion. Detected manually — opening rebuilds the word node, so no native dblclick.
        if (c && e.timeStamp - lastTapTime < 320 && Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) < 16) {
          lastTapTime = 0
          selectWordForDeletion(c.from, c.to)
          return
        }
        lastTapTime = e.timeStamp; lastTapX = e.clientX; lastTapY = e.clientY
        if (!c) return
        const el = e.target as HTMLElement | null
        const onCard = !!el?.closest?.('.scas-cycle-card')
        // The press that OPENED this cycle, released with no drag, commits the centred (original)
        // word — a single click "snaps it back". (To pick a synonym you press-hold-drag-release.)
        if (opened) { cancelAnim(); commitRested(); return }
        if (!onCard && el?.closest?.('.scas-red')) return   // tapped another red word — the open handler dealt with it
        cancelAnim()
        if (onCard) commitRested()                          // tap on the reel/word → confirm (even un-scrolled)
        else closeCycle()                                   // tap on empty space / body → dismiss
        return
      }
      if (wasDragging && c) {
        // A gentle release: ease the reel the rest of the way onto the centre slot, THEN commit —
        // so letting go off-centre shows the vertical settle (not an instant commit from wherever
        // it happened to be). A faster flick coasts (fling), and also settles + commits when it
        // stops. (A pre-release pause makes the smoothed velocity stale, so treat it as zero.)
        const v = e.timeStamp - lastT > 80 ? 0 : velRef.current
        if (Math.abs(v) <= COMMIT_VEL) { cancelAnim(); settleTo(Math.round(reelRef.current), commitLandedRest) }
        else fling(v)
      }
    }
    function onPointerCancel() {
      pointerIsDown = false
      const wasDragging = lastY !== null
      lastY = null; draggingRef.current = false
      if (wasDragging) { fling(velRef.current); scheduleMovingOff() }
    }
    // Suppress text-selection (highlighting) anywhere while a cycle is open — e.g. a
    // second press-and-drag away from the word would otherwise select editor text.
    function onSelectStart(e: Event) { if (cycleRef.current) e.preventDefault() }
    // Keep a touch drag from scrolling the document while it's steering the reel.
    function onTouchMove(e: TouchEvent) { if (lastY !== null) e.preventDefault() }

    document.addEventListener('wheel', onWheel, { passive: false })
    document.addEventListener('contextmenu', onContextMenu)
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('pointermove', onPointerMove)
    document.addEventListener('pointerup', onPointerUp)
    document.addEventListener('pointercancel', onPointerCancel)
    document.addEventListener('touchmove', onTouchMove, { passive: false })
    document.addEventListener('selectstart', onSelectStart)
    return () => {
      document.removeEventListener('wheel', onWheel)
      document.removeEventListener('contextmenu', onContextMenu)
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerup', onPointerUp)
      document.removeEventListener('pointercancel', onPointerCancel)
      document.removeEventListener('touchmove', onTouchMove)
      document.removeEventListener('selectstart', onSelectStart)
    }
  }, [editor]) // eslint-disable-line react-hooks/exhaustive-deps

  // While a cycle is open, suppress native touch-scroll on the editor so a finger
  // drag spins the reel instead of scrolling the document. Restored on close.
  useEffect(() => {
    if (!cycle || !editor) return
    const el = editor.view.dom as HTMLElement
    const prevTouch  = el.style.touchAction
    const prevSelect = el.style.userSelect
    el.style.touchAction = 'none'
    el.style.userSelect = 'none'
    el.style.setProperty('-webkit-user-select', 'none')
    return () => {
      el.style.touchAction = prevTouch
      el.style.userSelect = prevSelect
      el.style.removeProperty('-webkit-user-select')
    }
  }, [!!cycle]) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-measure geometry on scroll/resize.
  useEffect(() => {
    if (!cycle) return
    const bump = () => setGeomNonce(n => n + 1)
    window.addEventListener('resize', bump)
    window.addEventListener('scroll', bump, true)
    return () => { window.removeEventListener('resize', bump); window.removeEventListener('scroll', bump, true) }
  }, [!!cycle]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Geometry (memoised — depends on the focused word, NOT the reel position) ──

  const geom = useMemo(() => {
    if (!cycle) return null
    const focusedEl = editor.view.dom.querySelector('.scas-focused') as HTMLElement | null
    const cRect     = containerEl.current?.getBoundingClientRect()
    if (!focusedEl || !cRect) return null

    const rect = focusedEl.getBoundingClientRect()
    const cs   = window.getComputedStyle(focusedEl)
    const fsz  = parseFloat(cs.fontSize) || 18

    // EXIT-STATIONARY reel. Each synonym renders with its LEFT edge at the word's natural x —
    // exactly where it lands when committed (the text before it is unchanged), so the chosen
    // word doesn't jump on exit. A synonym wide enough to cross the writing-space edge is
    // shifted left ONLY as far as needed to stay inside it (such a word reflows to the next
    // line on commit anyway, so that residual offset is unavoidable — and kept minimal).
    const font         = getFont(focusedEl)
    const naturalLeftC = cycle.naturalLeft - cRect.left
    // The reserved box IS the focused word's expanded rect; the after-text begins at its right
    // edge, so reel words must stay within [boxLeft, boxRight] or they paint over the text. We use
    // the LIVE rendered rect directly (single coordinate source). The open layout is applied
    // instantly, so there's no half-grown box to outrun — the old MODEL-box / `settled` swap only
    // existed for a CSS-transition grow that the default path never ran, and switching model→live
    // ~150ms after every open was itself a guaranteed horizontal pop (audit F1/F4). Gone now.
    const boxLeftC  = rect.left  - cRect.left
    const boxRightC = rect.right - cRect.left
    const widths    = cycle.synonyms.map(s => measureTextWidth(s, font))
    const DOT_PAD   = 8   // room left of the word for the origin ink-blot
    const left      = boxLeftC - DOT_PAD
    // Card is wide enough to hold any synonym at its committed natural-x (where it slides to on
    // commit), so the slide-home tail is never clipped — without needing overflow:visible (which
    // would leak the faded neighbour rows and flash). Card stays transparent + overflow:hidden.
    const cardW     = Math.max(boxRightC - left, (naturalLeftC - left) + Math.max(...widths) + DOT_PAD)
    // Per-slot left within the card: natural x, clamped to the box (never past its right edge,
    // never left of its left edge).
    const slotLefts = widths.map(w =>
      Math.max(boxLeftC, Math.min(naturalLeftC, boxRightC - w)) - left,
    )

    const textNode = focusedEl.firstChild
    let textMid: number
    if (textNode?.nodeType === Node.TEXT_NODE) {
      const rng = document.createRange(); rng.selectNodeContents(textNode)
      const tr  = rng.getBoundingClientRect()
      textMid   = tr.top - cRect.top + tr.height / 2
    } else {
      textMid = rect.top - cRect.top + rect.height / 2
    }

    const rowH  = Math.round(fsz * 1.15)
    const cardH = rowH * 3                    // prev / current / next visible at once
    return {
      fsz, left, rowH, cardH, slotLefts,
      naturalInCard: naturalLeftC - left,     // the word's committed x, in card coords (slide target)
      cardTop: textMid - cardH / 2,           // current row centred on the focused word
      width: cardW,
      fontFamily: cs.fontFamily,
    }
  }, [cycle?.from, cycle?.minWidth, cycle?.synonyms, geomNonce]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Render ────────────────────────────────────────────────────────────────

  if (!cycle || !geom) return null
  rowHRef.current = geom.rowH
  const { fsz, left, rowH, cardH, cardTop, width, fontFamily, slotLefts } = geom
  const reel   = cycle.reelPos
  const mobile = window.innerWidth < 768 ? 1.4 : 1
  // Overlay mode (touch): the word isn't expanded, so size the opaque card to the widest
  // synonym (minWidth) and give it the paper colour so it masks the text it floats over.
  const cardWidth = cycle.overlay ? Math.ceil(cycle.minWidth) : width
  const cardBg    = cycle.overlay ? '#f7f2e8' : 'transparent'

  // Continuous windowed reel: render a band of rings around the live position, each
  // placed by its real distance from centre so the whole strip glides as reel moves.
  // Keys are absolute ring indices, so a word keeps its DOM node as it crosses the
  // centre; rows only mount/unmount at the faded edges (invisible). WINDOW=3 keeps the
  // 3-row card filled plus a fade margin, so a fast spin never shows white.
  const WINDOW = 3
  const base = Math.round(reel)
  // On commit the WHOLE reel eases onto the integer grid (chosen word → centre): every row gets
  // this same vertical shift, so the words above and below glide WITH the chosen word instead of
  // hanging at their offset and blinking out. (reel-base) is the fraction to absorb; for the centre
  // row it equals -rel, so the chosen word lands exactly on the text line.
  const reelSettle = (reel - base) * rowH
  const rows: React.ReactNode[] = []
  for (let d = -WINDOW; d <= WINDOW; d++) {
    const ring    = base + d
    const slotIdx = ((ring % CYCLE_SIZE) + CYCLE_SIZE) % CYCLE_SIZE
    const word    = cycle.synonyms[slotIdx]
    const rel     = ring - reel                       // continuous offset from centre, in rows
    const a       = Math.abs(rel)
    const isOrig  = word === cycle.synonyms[0]   // the original (dark); candidates are the lighter purple
    // The card is transparent and 3 rows tall, so at rest the peeking prev/next synonyms
    // bleed onto the text lines above and below (no background to mask them). So reveal the
    // neighbours ONLY while the reel is in motion: at rest just the centre word shows, in
    // place — calm, no bleed, nothing for the eye to read as movement. `reveal` collapses to
    // the centre row (a≈0) when still; the fade-out is transitioned (see row style) so the
    // ghosts settle softly, while motion keeps the per-frame opacity crisp (transition off).
    const reveal  = moving ? 1 : Math.max(0, 1 - a * 2.4)
    const opacity = Math.max(0, Math.min(1, 1.22 - a * 0.6)) * reveal
    rows.push(
      <div key={ring}
        style={{
          position: 'absolute', left: 0, right: 0, height: rowH,
          top: (cardH - rowH) / 2,
          display: 'flex', alignItems: 'center', justifyContent: 'flex-start',
          // No overflow:hidden here — the row box is only rowH tall (≈1.15em), so clipping it cut
          // the descenders (g/p/y) off the centre word. The CARD's overflow:hidden still bounds the
          // 3-row band; the centre row sits inside it, so its glyphs now show in full.
          whiteSpace: 'nowrap', cursor: 'pointer',
          fontSize: fsz,
          // Move via translateY only (compositor-only). No scale: scaling centred text
          // shifts its edges ~1px as the row's distance-from-centre wobbles, which reads
          // as a left/right jiggle while scrolling. Depth comes from the opacity fade.
          transform: `translateY(${(rel * rowH).toFixed(2)}px)`,
          willChange: 'transform',
          // Original word dark, secondary/candidate words the lighter purple — a committed
          // secondary word KEEPS this lighter colour (the page text matches it, see
          // .scas-secondary), so the colour never changes between reel, commit and page.
          color: isOrig ? '#9b5ccc' : '#5c2d8a',   // original = lighter; candidate synonyms = darker
          // On commit keep the chosen word opaque and fade the neighbours to 0 over the glide, so
          // they ease away in step with the reel settling rather than vanishing with the card.
          opacity: committing ? (ring === base ? 1 : 0) : opacity,
          // Only a continuous DRAG needs the crisp per-frame opacity (transition off, or it smears
          // the scrolling fade). A keyboard glide or the settle-to-rest should ease in/out — so the
          // neighbour rows fade rather than snap, killing the rapid-cycle strobe.
          transition: committing ? `opacity ${REFLOW_COMMIT_MS}ms ${REFLOW_EASE}` : (draggingRef.current ? 'none' : 'opacity 140ms ease'),
          WebkitTapHighlightColor: 'transparent',
        }}>
        {/* Left-align the word at its clamped natural-x offset within the card, so what's
            shown is exactly where it commits (no jump on exit). On COMMIT, slide it from there to
            its committed natural-x (translateX) over the same 240ms as the de-compression, so the
            word travels home WITH the surrounding text instead of snapping after it. The committed
            row (ring === base) ALSO glides vertically to the text line (translateY): if the reel
            was resting between slots, the chosen word eases onto the baseline instead of snapping. */}
        <span style={{ display: 'inline-block', whiteSpace: 'nowrap', marginLeft: `${slotLefts[slotIdx]}px`,
                       transform: committing
                         ? `translate(${(ring === base ? geom.naturalInCard - slotLefts[slotIdx] : 0).toFixed(2)}px, ${reelSettle.toFixed(2)}px)`
                         : 'none',
                       transition: committing ? `transform ${REFLOW_COMMIT_MS}ms ${REFLOW_EASE}` : 'none' }}>
        {displayFor(word, mobile)}
        </span>
      </div>,
    )
  }

  return (
    <>
      {/* Sliding reel card — fully transparent: no border/shadow/background, so the
          word floats directly on the parchment (lines above/below may show through).
          NB: do NOT put a transform on this card to "snap" sub-pixel position — promoting it to a
          GPU layer disables subpixel-antialiasing on the reel text (visible colour/weight shift)
          and nudges horizontal sub-pixel position. Keep it a plain absolutely-positioned box. */}
      <div className="absolute z-50 select-none scas-cycle-card"
        style={{ top: cardTop, left, width: cardWidth, height: cardH, boxSizing: 'border-box',
                 fontFamily, fontSize: fsz, overflow: 'hidden',
                 background: cardBg, WebkitTapHighlightColor: 'transparent' }}>
        {rows}
      </div>
    </>
  )
}
