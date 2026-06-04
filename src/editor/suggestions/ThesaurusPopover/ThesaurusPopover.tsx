// ThesaurusPopover — Word-cycle synonym interface.
// Keyboard: j/k cycle, Space accept+advance, Tab prev word, Shift+Tab next, Esc dismiss
// Slots: 0 = original word, 1–6 = synonyms, 7 = ⌫ delete
// Click/touch: opens cycle without moving cursor

import React, { useEffect, useRef } from 'react'
import type { Editor } from '@tiptap/react'
import { useCompliance } from '../../../scas/compliance'
import { CYCLE_SIZE, DELETE_SENTINEL } from './popoverConstants'
import type { CycleState, OnHintChange } from './popoverConstants'
import { posOf } from './popoverGeometry'
import { displayFor } from './popoverFallbacks'
import { usePopoverLayout } from './usePopoverLayout'

// Advance the cycle by d slots: currentIdx wraps (used for accept), reelPos is
// continuous so the render can translate the reel smoothly without seams.
function stepCycle(c: CycleState, d: number): CycleState {
  return {
    ...c,
    currentIdx: ((c.currentIdx + d) % CYCLE_SIZE + CYCLE_SIZE) % CYCLE_SIZE,
    reelPos: c.reelPos + d,
  }
}

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

  useEffect(() => { onCycleChange(!!cycle) }, [!!cycle]) // eslint-disable-line react-hooks/exhaustive-deps

  const redWords = () => Array.from(editor.view.dom.querySelectorAll<HTMLElement>('.scas-red'))

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
    if (replacement === DELETE_SENTINEL) {
      if (tabCursorRef.current !== null && from < tabCursorRef.current) tabCursorRef.current -= wl
      editor.chain().deleteRange({ from, to }).run()
    } else {
      if (tabCursorRef.current !== null && from < tabCursorRef.current) tabCursorRef.current += replacement.length - wl
      editor.chain().deleteRange({ from, to }).insertContentAt(from, replacement).run()
    }
    pinCursor(); recordAccepted(); setCycle(null); advanceOrRestore(from, advance)
  }

  // Refs so the Stage C mouse handlers (subscribed once, below) can read live
  // cycle state and the latest accept closure without re-subscribing on every
  // j/k step — which would otherwise reset the wheel/drag accumulators.
  const cycleRef = useRef(cycle)
  cycleRef.current = cycle
  const acceptRef = useRef(acceptSuggestion)
  acceptRef.current = acceptSuggestion

  // ── Events ────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!editor) return
    const edEl = editor.view.dom
    function onPointerDown(e: PointerEvent) {
      const t = (e.target as HTMLElement).closest('.scas-red') as HTMLElement | null
      if (!t || !edEl.contains(t)) return
      e.preventDefault(); tabCursorRef.current = null; openCycleForElement(t)
    }
    document.addEventListener('pointerdown', onPointerDown, { capture: true })
    return () => document.removeEventListener('pointerdown', onPointerDown, { capture: true })
  }, [editor]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!editor) return
    function onKeyDown(e: KeyboardEvent) {
      if (cycle) {
        e.stopPropagation()
        if (e.key === 'Escape') { e.preventDefault(); closeCycle(); return }
        if (e.key === 'j') { e.preventDefault(); setCycle(c => c ? stepCycle(c, -1) : c); return }
        if (e.key === 'k') { e.preventDefault(); setCycle(c => c ? stepCycle(c, +1) : c); return }
        if (e.key === 'Tab') {
          e.preventDefault(); recordIgnored()
          const found = e.shiftKey ? goNext(cycle.from) : goPrev(cycle.from)
          if (!found) { onHintChange(null, null); setCycle(null); restoreCursor() }
          return
        }
        if (e.key === ' ') { e.preventDefault(); acceptSuggestion(cycle.synonyms[cycle.currentIdx], true); return }
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

  // ── Stage C — mouse input ───────────────────────────────────────────────────
  // Subscribed once (deps: [editor]); reads live state via cycleRef/acceptRef so
  // the wheel/drag accumulators survive the rapid setCycle updates cycling fires.
  useEffect(() => {
    if (!editor) return
    const edEl = editor.view.dom

    // currentIdx delta: +1 = k (toward the word shown below), -1 = j (above).
    const cycleBy = (d: number) => setCycle(c => c ? stepCycle(c, d) : c)

    const overTarget = (t: EventTarget | null) => {
      const el = t as HTMLElement | null
      return !!el && (edEl.contains(el) || !!el.closest?.('.scas-cycle-card'))
    }

    // Trackpad-vs-mouse-wheel is heuristic — there is no reliable API. Physical
    // wheels emit line/page granularity OR large fixed integer pixel steps with no
    // horizontal component; trackpads emit small, often fractional pixel deltas and
    // frequently carry a horizontal component. We cycle ONLY on trackpad scrolls and
    // ignore the physical mouse wheel, leaving it free for the future anti-cheat gate.
    function isTrackpadScroll(e: WheelEvent): boolean {
      if (e.deltaMode !== 0) return false           // line/page mode → physical wheel
      if (e.deltaX !== 0) return true               // horizontal jitter → trackpad
      if (!Number.isInteger(e.deltaY)) return true  // sub-pixel delta → trackpad
      return Math.abs(e.deltaY) < 50                // small step → trackpad; large notch → wheel
    }

    const WHEEL_STEP = 40
    let wheelAccum = 0
    function onWheel(e: WheelEvent) {
      if (!cycleRef.current || !overTarget(e.target)) return
      if (!isTrackpadScroll(e)) return              // reserved for the anti-cheat gate
      e.preventDefault()
      wheelAccum += e.deltaY
      while (wheelAccum >=  WHEEL_STEP) { cycleBy(-1); wheelAccum -= WHEEL_STEP }  // down → j
      while (wheelAccum <= -WHEEL_STEP) { cycleBy(1);  wheelAccum += WHEEL_STEP }  // up → k
    }

    // Right-click accepts the current synonym (same as Space).
    function onContextMenu(e: MouseEvent) {
      const c = cycleRef.current
      if (!c || !overTarget(e.target)) return
      e.preventDefault()
      acceptRef.current(c.synonyms[c.currentIdx], true)
    }

    // Press + drag up/down cycles, ~20px per step. Works for both mouse (button
    // held) and touch (finger down) — we track clientY deltas ourselves rather
    // than movementY, which mobile browsers report unreliably on touch pointers.
    // Releasing after a drag that moved the reel commits the word it landed on.
    //
    // Steps are coalesced into one setCycle per animation frame: touch pointermove
    // can fire faster than the display refreshes, and a render-per-event janks the
    // phone. baseIdx + netSteps is the source of truth for the landed-on slot, so
    // the release accepts correctly regardless of React's render timing.
    const DRAG_STEP = 20
    let dragAccum = 0
    let lastY: number | null = null // non-null once a held drag is in progress
    let baseIdx  = 0                // currentIdx when this drag began
    let netSteps = 0                // steps accumulated since drag began
    let applied  = 0                // steps already pushed to React state
    let rafId: number | null = null
    function flush() {
      rafId = null
      const delta = netSteps - applied
      if (delta !== 0) { cycleBy(delta); applied = netSteps }
    }
    function onPointerMove(e: PointerEvent) {
      if (!(e.buttons & 1) || !cycleRef.current) { lastY = null; return }
      if (lastY === null) {
        lastY = e.clientY; baseIdx = cycleRef.current.currentIdx
        netSteps = 0; applied = 0; edEl.style.userSelect = 'none'; return
      }
      dragAccum += e.clientY - lastY
      lastY = e.clientY
      while (dragAccum <= -DRAG_STEP) { netSteps += 1; dragAccum += DRAG_STEP }  // up → k
      while (dragAccum >=  DRAG_STEP) { netSteps -= 1; dragAccum -= DRAG_STEP }  // down → j
      if (netSteps !== applied && rafId === null) rafId = requestAnimationFrame(flush)
    }
    function endDrag(accept: boolean) {
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null }
      if (lastY !== null) edEl.style.userSelect = ''
      // A drag that moved the reel commits on release; a stationary press (a plain
      // click/tap that just opens the cycle) leaves it open for keyboard/tap input.
      if (accept && netSteps !== 0) {
        const c = cycleRef.current
        if (c) {
          const idx = (((baseIdx + netSteps) % CYCLE_SIZE) + CYCLE_SIZE) % CYCLE_SIZE
          acceptRef.current(c.synonyms[idx], false)
        }
      } else {
        flush()  // cancel / no-accept: settle the reel to its final dragged position
      }
      lastY = null; dragAccum = 0; netSteps = 0; applied = 0
    }
    const onPointerUp     = () => endDrag(true)
    const onPointerCancel = () => endDrag(false)
    // Keep a touch drag from scrolling the document while it's steering the reel.
    function onTouchMove(e: TouchEvent) { if (lastY !== null) e.preventDefault() }

    document.addEventListener('wheel', onWheel, { passive: false })
    document.addEventListener('contextmenu', onContextMenu)
    document.addEventListener('pointermove', onPointerMove)
    document.addEventListener('pointerup', onPointerUp)
    document.addEventListener('pointercancel', onPointerCancel)
    document.addEventListener('touchmove', onTouchMove, { passive: false })
    return () => {
      document.removeEventListener('wheel', onWheel)
      document.removeEventListener('contextmenu', onContextMenu)
      document.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerup', onPointerUp)
      document.removeEventListener('pointercancel', onPointerCancel)
      document.removeEventListener('touchmove', onTouchMove)
    }
  }, [editor]) // eslint-disable-line react-hooks/exhaustive-deps

  // While a cycle is open, suppress native touch-scroll on the editor so a finger
  // drag cycles synonyms instead of scrolling the document. Restored on close.
  useEffect(() => {
    if (!cycle || !editor) return
    const el = editor.view.dom as HTMLElement
    const prev = el.style.touchAction
    el.style.touchAction = 'none'
    return () => { el.style.touchAction = prev }
  }, [!!cycle]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!cycle) return
    const outside = (t: HTMLElement | null) => !!t && !t.closest?.('.scas-red') && !t.closest?.('.scas-cycle-card')
    const onMD = (e: MouseEvent)  => { if (outside(e.target as HTMLElement)) closeCycle() }
    const onTS = (e: TouchEvent)  => {
      const t = e.touches[0] && document.elementFromPoint(e.touches[0].clientX, e.touches[0].clientY) as HTMLElement | null
      if (outside(t)) closeCycle()
    }
    document.addEventListener('mousedown', onMD)
    document.addEventListener('touchstart', onTS, { passive: true })
    return () => { document.removeEventListener('mousedown', onMD); document.removeEventListener('touchstart', onTS) }
  }, [cycle]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Render ────────────────────────────────────────────────────────────────

  if (!cycle) return null
  const focusedEl = editor.view.dom.querySelector('.scas-focused') as HTMLElement | null
  const cRect     = containerEl.current?.getBoundingClientRect()
  if (!focusedEl || !cRect) return null

  const rect = focusedEl.getBoundingClientRect()
  const cs   = window.getComputedStyle(focusedEl)
  const fsz  = parseFloat(cs.fontSize) || 18
  const left = rect.left - cRect.left

  const textNode = focusedEl.firstChild
  let textMid: number
  if (textNode?.nodeType === Node.TEXT_NODE) {
    const rng = document.createRange(); rng.selectNodeContents(textNode)
    const tr  = rng.getBoundingClientRect()
    textMid   = tr.top - cRect.top + tr.height / 2
  } else {
    textMid = rect.top - cRect.top + rect.height / 2
  }

  const rowH    = Math.round(fsz * 1.15)
  const cardH   = rowH * 3                 // prev / current / next visible at once
  const cardTop = textMid - cardH / 2      // current row centred on the focused word
  const mobile  = window.innerWidth < 768 ? 1.4 : 1

  // Continuous reel (Stage D): render a small window of slots around reelPos and
  // let CSS transitions slide each word between positions as the cycle advances.
  // d 0 = centre (current), ±1 = neighbours, |d|≥2 = hidden buffer the incoming
  // row animates in from. Keys are slot indices (stable while on-screen), so a
  // given word keeps its DOM node and its top/opacity/size transition smoothly.
  const WINDOW = 2
  const rows: React.ReactNode[] = []
  for (let d = -WINDOW; d <= WINDOW; d++) {
    const slotIdx = (((cycle.reelPos + d) % CYCLE_SIZE) + CYCLE_SIZE) % CYCLE_SIZE
    const word    = cycle.synonyms[slotIdx]
    const center  = d === 0
    const isOrig  = word === cycle.synonyms[0]
    const opacity = Math.abs(d) >= 2 ? 0 : center ? (word === DELETE_SENTINEL ? 0.70 : 1) : 0.72
    rows.push(
      <div key={slotIdx} onClick={() => acceptSuggestion(word, true)}
        style={{
          position: 'absolute', left: 0, right: 0, height: rowH,
          top: (cardH - rowH) / 2 + d * rowH,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          whiteSpace: 'nowrap', overflow: 'hidden', cursor: 'pointer',
          fontSize: fsz,
          transform: center ? 'scale(1)' : 'scale(0.92)',
          transformOrigin: 'center',
          color: isOrig ? '#5c2d8a' : '#9b5ccc',
          opacity,
          // Animate only composited props (top/opacity/transform) — a font-size
          // transition forces per-frame text relayout and janks the slide on mobile.
          transition: 'top 150ms ease, opacity 150ms ease, transform 150ms ease',
          WebkitTapHighlightColor: 'transparent',
        }}>
        {displayFor(word, mobile)}
      </div>,
    )
  }

  return (
    <>
      {/* Glyph placeholder — vertically centred on the current row */}
      <div className="absolute z-50 pointer-events-none select-none text-stone-300"
        style={{ position: 'absolute', top: textMid - rowH / 2, left: left - 18,
                 height: rowH, lineHeight: `${rowH}px`, fontFamily: cs.fontFamily, fontSize: fsz }}>◯</div>

      {/* Sliding reel card */}
      <div className="absolute z-50 select-none scas-cycle-card"
        style={{ top: cardTop, left, width: Math.ceil(rect.width), height: cardH, boxSizing: 'border-box',
                 fontFamily: cs.fontFamily, fontSize: fsz, overflow: 'hidden',
                 background: 'white', border: '1px solid rgba(92, 45, 138, 0.75)', borderRadius: '10px',
                 boxShadow: '0 1px 4px rgba(0,0,0,0.06)', WebkitTapHighlightColor: 'transparent' }}>
        {rows}
      </div>
    </>
  )
}
