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
import { CYCLE_SIZE } from './popoverConstants'
import type { OnHintChange } from './popoverConstants'
import { posOf } from './popoverGeometry'
import { displayFor } from './popoverFallbacks'
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
}

export function ThesaurusPopover({ editor, paragraphIndex, containerEl, onHintChange, onCycleChange }: ThesaurusPopoverProps) {
  const { recordAccepted, recordIgnored } = useCompliance()
  const tabCursorRef = useRef<number | null>(null)
  const { cycle, setCycle, openCycleForElement } = usePopoverLayout(editor, onHintChange)

  // Bump on scroll/resize so the memoised geometry recomputes; reel animation does NOT
  // touch this, so per-frame reelPos updates never redo getBoundingClientRect.
  const [geomNonce, setGeomNonce] = useState(0)

  useEffect(() => { onCycleChange(!!cycle) }, [!!cycle]) // eslint-disable-line react-hooks/exhaustive-deps

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
  function scheduleMovingOff(delay = 120) {
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
    if (record) recordIgnored(); onHintChange(null, null); setCycle(null); if (restore) restoreCursor()
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
    const { from, to } = cycle; const wl = to - from
    onHintChange(null, null)
    if (replacement !== editor.state.doc.textBetween(from, to)) {
      if (tabCursorRef.current !== null && from < tabCursorRef.current) tabCursorRef.current += replacement.length - wl
      // Carry the SCAS-slot mark (anchored to this slot's original word) so the position
      // stays managed: it keeps rendering red/changeable even if the new word is in vocab,
      // and reopening re-offers the original's synonym list. cycle.word holds the original.
      editor.chain().deleteRange({ from, to }).insertContentAt(from, {
        type: 'text', text: replacement,
        marks: [{ type: 'scasSlot', attrs: { original: cycle.word } }],
      }).run()
    }
    // else: committing the unchanged original — record the deliberate choice, skip the edit.
    pinCursor(); recordAccepted(); setCycle(null); advanceOrRestore(from, advance)
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

  // Ease reelPos to an integer slot and rest there. No commit — the writer accepts
  // by tapping the rested word (or anywhere else); see the pointer handlers below.
  function settleTo(target: number) {
    cancelAnim()
    targetRef.current = target
    const start = reelRef.current
    const dist  = target - start
    if (Math.abs(dist) < 0.001) { reelRef.current = target; pushReel(); return }
    const dur = Math.min(280, 130 + Math.abs(dist) * 90)
    let t0: number | null = null
    const step = (t: number) => {
      if (t0 === null) t0 = t
      const p = Math.min(1, (t - t0) / dur)
      const e = 1 - Math.pow(1 - p, 3)            // easeOutCubic
      reelRef.current = start + dist * e
      pushReel()
      if (p < 1) { rafRef.current = requestAnimationFrame(step) }
      else { rafRef.current = null; reelRef.current = target; pushReel() }
    }
    rafRef.current = requestAnimationFrame(step)
  }

  // Coast with the release velocity, decaying exponentially, then rest on the nearest
  // slot. Low/zero v0 rests almost immediately. No auto-commit — tap to accept.
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
      if (Math.abs(velRef.current) < VEL_STOP) { rafRef.current = null; settleTo(Math.round(reelRef.current)) }
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
      openCycleForElement(t)
    }
    document.addEventListener('pointerdown', onPointerDown, { capture: true })
    return () => document.removeEventListener('pointerdown', onPointerDown, { capture: true })
  }, [editor]) // eslint-disable-line react-hooks/exhaustive-deps

  // Reset the reel whenever a different word is focused (or the cycle opens/closes).
  // Keyed on `from` only — synonym loads (which keep `from`) must not reset position.
  // Also keyed on cycle.synonyms: when the real synonym list loads it carries the
  // reel position centred on the current word, so resync reelRef to it then.
  useEffect(() => {
    cancelAnim()
    velRef.current = 0
    engagedRef.current = false
    reelRef.current = cycle ? cycle.reelPos : 0
    targetRef.current = cycle ? Math.round(cycle.reelPos) : 0
    // Light the original marker the moment a cycle opens or moves to another word — it
    // renders only if the original is in view — then let it linger briefly and fade.
    if (cycle) { setMoving(true); scheduleMovingOff(650) }
    else { if (movingTimerRef.current) clearTimeout(movingTimerRef.current); setMoving(false) }
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

    // Trackpad-vs-mouse-wheel is heuristic — there is no reliable API. Physical
    // wheels emit line/page granularity OR large fixed integer pixel steps with no
    // horizontal component; trackpads emit small, often fractional pixel deltas and
    // frequently carry a horizontal component. We scroll ONLY on trackpad and ignore
    // the physical mouse wheel, leaving it free for the future anti-cheat gate.
    function isTrackpadScroll(e: WheelEvent): boolean {
      if (e.deltaMode !== 0) return false           // line/page mode → physical wheel
      if (e.deltaX !== 0) return true               // horizontal jitter → trackpad
      if (!Number.isInteger(e.deltaY)) return true  // sub-pixel delta → trackpad
      return Math.abs(e.deltaY) < 50                // small step → trackpad; large notch → wheel
    }

    // Trackpad: scroll the continuous reel directly, then settle to the nearest slot
    // when the gesture goes idle (no accept — trackpad is for browsing).
    let wheelIdle: ReturnType<typeof setTimeout> | null = null
    function onWheel(e: WheelEvent) {
      if (!cycleRef.current || !overTarget(e.target)) return
      if (!isTrackpadScroll(e)) return              // reserved for the anti-cheat gate
      e.preventDefault()
      cancelAnim()
      reelRef.current -= e.deltaY / (rowHRef.current || 1)   // down → previous, matching a downward drag
      pushReel()
      if (wheelIdle) clearTimeout(wheelIdle)
      wheelIdle = setTimeout(() => settleTo(Math.round(reelRef.current)), 90)
    }

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
    // Commit model: a SHORT click (still + quick) commits the rested word. A press-
    // and-hold — on the word or anywhere else — does NOT commit, so you can keep
    // changing it (drag to scroll, release to rest, repeat) until a short click.
    const TAP_PX = 6                                 // pointer travel under this = still
    const TAP_MS = 250                               // press under this = a short click (commit)
    let lastY: number | null = null
    let lastT = 0
    let downX = 0, downY = 0, downT = 0
    let lastTapTime = 0, lastTapX = 0, lastTapY = 0   // for manual double-tap detection
    let pushScheduled = false
    function schedulePush() {
      if (pushScheduled) return
      pushScheduled = true
      requestAnimationFrame(() => { pushScheduled = false; pushReel() })
    }
    function onPointerDown(e: PointerEvent) {
      downX = e.clientX; downY = e.clientY; downT = e.timeStamp
      lastY = null                                   // a drag begins on the first move
    }
    function onPointerMove(e: PointerEvent) {
      if (!(e.buttons & 1) || !cycleRef.current) { lastY = null; draggingRef.current = false; return }
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
    // Commit the word the reel is resting on, honouring the original/engaged rule:
    // the original (slot 0) only commits once the reel has actually moved a spot.
    function commitRested() {
      const c = cycleRef.current; if (!c) return
      const idx = slotAt(reelRef.current)
      if (idx === 0 && !engagedRef.current) closeCycle()
      else acceptRef.current(c.synonyms[idx], false)
    }
    function onPointerUp(e: PointerEvent) {
      const wasDragging = lastY !== null
      lastY = null
      draggingRef.current = false
      if (wasDragging) scheduleMovingOff()   // released a drag: fade once the reel rests
      const opened = openedByPointerRef.current
      openedByPointerRef.current = false
      const c = cycleRef.current
      const dist = Math.hypot(e.clientX - downX, e.clientY - downY)
      if (dist < TAP_PX && e.timeStamp - downT < TAP_MS) {
        // Double-tap (two quick taps near each other) on the open word selects it for
        // deletion. Detected manually — opening rebuilds the word node, so no native dblclick.
        if (c && e.timeStamp - lastTapTime < 320 && Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) < 16) {
          lastTapTime = 0
          selectWordForDeletion(c.from, c.to)
          return
        }
        lastTapTime = e.timeStamp; lastTapX = e.clientX; lastTapY = e.clientY
        // The press that opened the cycle leaves it open — don't commit on the same
        // tap, regardless of whether the card painted before this release fired.
        if (opened || !c) return
        const el = e.target as HTMLElement | null
        if (el?.closest?.('.scas-red') && !el.closest?.('.scas-cycle-card')) return
        cancelAnim(); commitRested()
        return
      }
      if (wasDragging && c) {
        // A gentle release means the reel has effectively landed → commit it. (If the
        // finger paused before lifting, the smoothed velocity is stale, so treat a
        // pre-release pause as zero so a deliberate landing still commits.) A faster
        // flick coasts and rests instead — click again to accept.
        const v = e.timeStamp - lastT > 80 ? 0 : velRef.current
        if (Math.abs(v) <= COMMIT_VEL) { cancelAnim(); commitRested() }
        else fling(v)
      }
    }
    function onPointerCancel() {
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
      if (wheelIdle) clearTimeout(wheelIdle)
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

    // Anchor the reel to the word's KNOWN natural x (measured before expansion), using the
    // INTENDED slide — never the rendered box. The expanded box's left is naturalLeft minus
    // however far the browser actually paints the negative letter-spacing, which is font-
    // specific and sub-pixel-variable; reading it back made the original word drift, and when
    // the real slide exceeded `exp` the [0,1] clamp parked the word LEFT of its left neighbour
    // (the serif "prehensile|tail" overlap). Both naturalLeft and alignFraction (= intended
    // beforeShift/exp) are known up front, so placing the card at naturalLeft − alignF·exp
    // lands the original word on its pre-click x EXACTLY, in any font, with no clamp.
    // f→0 left-aligned, .5 centred, →1 right-aligned: the continuum, still intact.
    const exp    = Math.max(0, cycle.minWidth - cycle.naturalWidth)
    const alignF = exp > 0 ? cycle.alignFraction : 0
    const cardW  = Math.max(Math.ceil(cycle.minWidth), Math.ceil(rect.width))
    const left   = (cycle.naturalLeft - cRect.left) - alignF * exp

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
      fsz, left, rowH, cardH, alignF,
      cardTop: textMid - cardH / 2,           // current row centred on the focused word
      width: cardW,                           // reserved width (known min-width, font-agnostic)
      fontFamily: cs.fontFamily,
    }
  }, [cycle?.from, cycle?.minWidth, geomNonce]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Render ────────────────────────────────────────────────────────────────

  if (!cycle || !geom) return null
  rowHRef.current = geom.rowH
  const { fsz, left, rowH, cardH, cardTop, width, fontFamily, alignF } = geom
  const fPct   = (alignF * 100).toFixed(3) // align each reel word at fraction f of the card
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
  const rows: React.ReactNode[] = []
  for (let d = -WINDOW; d <= WINDOW; d++) {
    const ring    = base + d
    const slotIdx = ((ring % CYCLE_SIZE) + CYCLE_SIZE) % CYCLE_SIZE
    const word    = cycle.synonyms[slotIdx]
    const rel     = ring - reel                       // continuous offset from centre, in rows
    const a       = Math.abs(rel)
    const isOrig  = word === cycle.synonyms[0]
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
          whiteSpace: 'nowrap', overflow: 'hidden', cursor: 'pointer',
          fontSize: fsz,
          // Move via translateY only (compositor-only). No scale: scaling centred text
          // shifts its edges ~1px as the row's distance-from-centre wobbles, which reads
          // as a left/right jiggle while scrolling. Depth comes from the opacity fade.
          transform: `translateY(${(rel * rowH).toFixed(2)}px)`,
          willChange: 'transform',
          color: isOrig ? '#5c2d8a' : '#9b5ccc',
          opacity,
          // Smooth the neighbours' fade-out when the reel settles; none while moving so the
          // per-frame opacity stays crisp (a transition would smear the scrolling fade).
          transition: moving ? 'none' : 'opacity 160ms ease',
          WebkitTapHighlightColor: 'transparent',
        }}>
        {/* margin-left:f% then translateX(-f%) places the word at fraction f of the card's
            free space (any width), so the original lands on its natural x for every word. */}
        <span style={{ display: 'inline-block', whiteSpace: 'nowrap', marginLeft: `${fPct}%`, transform: `translateX(-${fPct}%)` }}>
        {slotIdx === 0 ? (
          // The original word carries a little uneven ink-blot, pinned just before its
          // first letter (so it rides with the word). It marks the original whenever that
          // word is the one resting in place (a≈0), and stays lit while the reel scrolls so
          // you can see the original pass; it only hides on the off-centre rows mid-spin.
          <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap' }}>
            <span aria-hidden="true" className="scas-origin-dot"
              style={{ position: 'absolute', right: '100%', marginRight: '1.5px', top: '50%',
                       width: 4.5, height: 5, background: '#5c2d8a',
                       borderRadius: '70% 30% 55% 45% / 55% 65% 35% 45%',
                       transform: 'translateY(-50%) rotate(-18deg)',
                       // No opacity transition: the original passes dead-centre faster than a
                       // fade, so a transition lags behind the motion. The row's opacity fade
                       // (which it inherits) already smooths it spatially as it scrolls.
                       opacity: (moving || a < 0.5) ? 1 : 0, pointerEvents: 'none' }} />
            {displayFor(word, mobile)}
          </span>
        ) : displayFor(word, mobile)}
        </span>
      </div>,
    )
  }

  return (
    <>
      {/* Sliding reel card — fully transparent: no border/shadow/background, so the
          word floats directly on the parchment (lines above/below may show through). */}
      <div className="absolute z-50 select-none scas-cycle-card"
        style={{ top: cardTop, left, width: cardWidth, height: cardH, boxSizing: 'border-box',
                 fontFamily, fontSize: fsz, overflow: 'hidden',
                 background: cardBg, WebkitTapHighlightColor: 'transparent' }}>
        {rows}
      </div>
    </>
  )
}
