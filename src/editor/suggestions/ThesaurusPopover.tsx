// ThesaurusPopover — Word-cycle synonym interface.
//
// Display (3-item vertical slot machine):
//   prev synonym  — one line above, faded
//   CURRENT       — overlaid on the focused word (word text is hidden via decoration)
//   next synonym  — one line below, faded
//   ◯             — placeholder glyph to the left (future: per-paragraph glyph)
//
// Keyboard:
//   j / k         → cycle down / up through 8 options (wraps)
//   Space         → accept current option and advance to next red word
//   Tab           → skip, go to previous red word
//   Shift+Tab     → skip, go to next red word
//   Esc           → dismiss without change
//
// Cycle slots (8 total):
//   0  — original word (default, no change on first open)
//   1  — ⌫ delete the word entirely
//   2–7 — synonyms from thesaurus
//
// Click / touch:
//   Clicking or tapping a red word opens the cycle without moving the cursor.

import React, { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { getSynonyms } from './thesaurus'
import { useCompliance } from '../../scas/compliance'
import { getFont, measureTextWidth } from './textMetrics'

const CYCLE_SIZE = 8
// Sentinel stored in the synonyms array to represent "delete this word".
const DELETE_SENTINEL = '\x00delete'
const DELETE_DISPLAY  = '⌫'

function displayFor(s: string, mobileScale = 1): React.ReactNode {
  if (s !== DELETE_SENTINEL) return s
  // Always render ⌫ in a system font — IM Fell DW Pica doesn't have this glyph.
  // On desktop: scale down slightly (system-ui has a larger x-height than the serifed font).
  // On mobile: scale up for tap target.
  const fontSize = mobileScale > 1 ? `${mobileScale}em` : '0.82em'
  const style: React.CSSProperties = { fontFamily: 'system-ui, sans-serif', fontSize }
  if (mobileScale > 1) style.lineHeight = '1'
  return <span style={style}>{DELETE_DISPLAY}</span>
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface CycleState {
  word: string
  from: number
  to: number
  synonyms: string[]   // exactly CYCLE_SIZE entries
  currentIdx: number
  minWidth: number     // px — min-width applied to focused word decoration
  naturalWidth: number // px — word's natural width before decoration
}

interface ThesaurusPopoverProps {
  editor: Editor
  paragraphIndex: number
  containerEl: React.RefObject<HTMLDivElement>
  onHintChange: (
    pos: number | null,
    minWidth?: number | null,
    lineRange?: { from: number; to: number; letterSpacingEm: number; offsetLeft: number } | null,
  ) => void
  onCycleChange: (active: boolean) => void
}

export function ThesaurusPopover({
  editor,
  paragraphIndex,
  containerEl,
  onHintChange,
  onCycleChange,
}: ThesaurusPopoverProps) {
  const [cycle, setCycle] = useState<CycleState | null>(null)
  const [, forceUpdate] = useState(0)
  const { recordAccepted, recordIgnored } = useCompliance()
  const tabCursorRef = useRef<number | null>(null)

  // Notify parent when cycle opens / closes so the hint panel can show/hide.
  useEffect(() => {
    onCycleChange(!!cycle)
  }, [!!cycle]) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-render on zoom or scroll so live DOM positions stay in sync.
  useEffect(() => {
    if (!cycle) return
    const update = () => forceUpdate(n => n + 1)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [!!cycle]) // eslint-disable-line react-hooks/exhaustive-deps

  // Line-compression effect: compress ALL non-word chars on the focused word's
  // visual line (both before and after) to absorb the min-width expansion evenly.
  // To prevent flows-back, we add margin-left to the focused word equal to the
  // total space lost by compressing chars before it (offsetLeft), anchoring it
  // to its original horizontal position regardless of zoom or line position.
  useEffect(() => {
    if (!cycle) return

    function updateCompression() {
      const focusedEl = editor.view.dom.querySelector('.scas-focused') as HTMLElement | null
      if (!focusedEl) return

      const fRect = focusedEl.getBoundingClientRect()
      const lineMidY = (fRect.top + fRect.bottom) / 2
      const paraEl = focusedEl.closest('p')
      if (!paraEl) return

      let lineFrom: number | null = null
      let lineTo:   number | null = null
      let charsBefore = 0
      let charsAfter  = 0
      // firstWordChars: count of before-chars up to the first space on the line.
      // The widget width is based only on this count — we only need to anchor
      // the first word so it cannot flow back to the previous line.
      let firstWordChars  = 0
      let pastFirstSpace  = false

      const walker = document.createTreeWalker(paraEl, NodeFilter.SHOW_TEXT)
      const r = document.createRange()

      for (;;) {
        const node = walker.nextNode() as Text | null
        if (!node) break
        if (!node.length) continue

        // Skip text nodes entirely above/below this line.
        r.setStart(node, 0)
        r.setEnd(node, node.length)
        const nr = r.getBoundingClientRect()
        if (nr.bottom < fRect.top - 2 || nr.top > fRect.bottom + 2) continue

        // Use a strict vertical tolerance: chars must have their midpoint within
        // 30% of the focused word's line-box height from the line centre.
        // This avoids accidentally catching chars on adjacent lines at any zoom.
        const tolerance = fRect.height * 0.3
        for (let i = 0; i < node.length; i++) {
          r.setStart(node, i)
          r.setEnd(node, i + 1)
          const cr = r.getBoundingClientRect()
          if (Math.abs((cr.top + cr.bottom) / 2 - lineMidY) < tolerance) {
            try {
              const pmPos = editor.view.posAtDOM(node, i)
              if (pmPos < cycle!.from) {
                // Char is before the focused word on this visual line.
                if (lineFrom === null || pmPos < lineFrom) lineFrom = pmPos
                charsBefore++
                // Track the first word on the line (up to first whitespace).
                // Walker order is left-to-right, so the first space encountered
                // is the boundary between the first and second words.
                if (!pastFirstSpace) {
                  const ch = node.data[i] ?? ''
                  if (ch === ' ' || ch === '\t' || ch === ' ') {
                    pastFirstSpace = true
                  } else {
                    firstWordChars++
                  }
                }
              } else if (pmPos >= cycle!.to) {
                // Char is after the focused word on this visual line.
                if (lineTo === null || pmPos + 1 > lineTo) lineTo = pmPos + 1
                charsAfter++
              }
            } catch { /* skip non-editable nodes */ }
          }
        }
      }

      const totalNonWord = charsBefore + charsAfter
      if (totalNonWord === 0) {
        onHintChange(cycle!.from, cycle!.minWidth, null)
        return
      }

      const expansion = Math.max(0, cycle!.minWidth - cycle!.naturalWidth)
      const fontSize  = parseFloat(window.getComputedStyle(focusedEl).fontSize) || 18
      const lsEm      = expansion > 0 ? expansion / totalNonWord / fontSize : 0

      // offsetLeft: compensation widget width — only the first word's compression.
      // The first word is what the browser considers when deciding whether to
      // reflow the line; anchoring it is sufficient to prevent flows-back.
      const offsetLeft = firstWordChars * lsEm * fontSize

      // Use cycle.from as the range start when there are no before-chars so
      // RedHighlightExtension's "lf < fw.from" guard stays false in that case.
      const rangeFrom = lineFrom ?? cycle!.from

      onHintChange(
        cycle!.from,
        cycle!.minWidth,
        lsEm > 0
          ? { from: rangeFrom, to: lineTo ?? cycle!.to, letterSpacingEm: lsEm, offsetLeft }
          : null,
      )
    }

    // RAF ensures the min-width decoration has been painted before we measure.
    const raf = requestAnimationFrame(updateCompression)
    window.addEventListener('resize', updateCompression)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', updateCompression)
    }
  }, [cycle?.from]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Cursor management ──────────────────────────────────────────────────────

  function restoreCursor() {
    if (tabCursorRef.current !== null) {
      const pos = tabCursorRef.current
      tabCursorRef.current = null
      requestAnimationFrame(() => {
        if (!editor.isDestroyed) editor.chain().focus().setTextSelection(pos).run()
      })
    }
  }

  function pinCursor() {
    if (tabCursorRef.current !== null && !editor.isDestroyed) {
      editor.commands.setTextSelection(tabCursorRef.current)
    }
  }

  // ── Cycle lifecycle ────────────────────────────────────────────────────────

  function closeCycle(record = true, restore = true) {
    if (record) recordIgnored()
    onHintChange(null, null)
    setCycle(null)
    if (restore) restoreCursor()
  }

  // ── DOM helpers ────────────────────────────────────────────────────────────

  function allRedWords(): HTMLElement[] {
    return Array.from(editor.view.dom.querySelectorAll<HTMLElement>('.scas-red'))
  }

  function posOf(el: HTMLElement): number {
    try { return editor.view.posAtDOM(el.firstChild ?? el, 0) } catch { return -1 }
  }

  // ── Open cycle ─────────────────────────────────────────────────────────────

  function openCycleForElement(target: HTMLElement) {
    // displayWord preserves original capitalisation for showing in the cycle.
    // lookupWord is lowercase for the thesaurus API.
    const displayWord = target.textContent ?? ''
    const lookupWord  = target.dataset.word ?? displayWord.toLowerCase()
    if (!lookupWord) return

    let domPos: number
    try {
      domPos = editor.view.posAtDOM(target.firstChild ?? target, 0)
    } catch { return }

    // Capture geometry BEFORE the async getSynonyms call — layout is still natural here.
    const rect = target.getBoundingClientRect()
    const font = getFont(target)
    const wordWidth = rect.width

    getSynonyms(lookupWord).then((candidates) => {
      // Slot 0 = original word, slots 1-6 = synonyms, slot 7 = delete sentinel.
      // Delete is above index 0 (reached by pressing j once from default).
      const base = [displayWord, ...candidates].slice(0, CYCLE_SIZE - 1)
      const padded = Array.from(
        { length: CYCLE_SIZE - 1 },
        (_, i) => base[i % Math.max(base.length, 1)]
      )
      const synonyms = [...padded, DELETE_SENTINEL]

      // Exclude the sentinel from width measurement (⌫ is narrow).
      // Add card horizontal padding on both sides so the reserved space already
      // includes the breathing room — no positional offset needed at render time.
      const CARD_PAD_X = 3
      const measurable = synonyms.filter(s => s !== DELETE_SENTINEL)
      const maxWidth = Math.max(wordWidth, ...measurable.map(s => measureTextWidth(s, font))) + CARD_PAD_X * 2
      onHintChange(domPos, maxWidth)
      setCycle({
        word: lookupWord,
        from: domPos,
        to: domPos + displayWord.length,
        synonyms,
        currentIdx: 0,
        minWidth: maxWidth,
        naturalWidth: wordWidth,
      })
    })
  }

  // ── Navigation ─────────────────────────────────────────────────────────────

  function goNext(afterPos: number, maxPos?: number): boolean {
    const next = allRedWords().find(el => {
      const p = posOf(el)
      return p > afterPos && (maxPos === undefined || p < maxPos)
    })
    if (next) { openCycleForElement(next); return true }
    return false
  }

  function goPrev(beforePos: number): boolean {
    const prev = [...allRedWords()].reverse().find(el => posOf(el) < beforePos)
    if (prev) { openCycleForElement(prev); return true }
    return false
  }

  // ── Pointer handler (mouse + touch unified) ────────────────────────────────
  useEffect(() => {
    if (!editor) return
    const editorEl = editor.view.dom

    // pointerdown fires for both mouse clicks and finger taps.
    // Capturing at document level ensures we beat ProseMirror's own handlers.
    function onPointerDown(e: PointerEvent) {
      const target = (e.target as HTMLElement).closest('.scas-red') as HTMLElement | null
      if (!target || !editorEl.contains(target)) return
      e.preventDefault()
      tabCursorRef.current = null
      openCycleForElement(target)
    }

    document.addEventListener('pointerdown', onPointerDown, { capture: true })
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, { capture: true })
    }
  }, [editor]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Key handler ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!editor) return

    function onKeyDown(e: KeyboardEvent) {
      // ── Cycle open ─────────────────────────────────────────────────────────
      if (cycle) {
        e.stopPropagation()

        if (e.key === 'Escape') { e.preventDefault(); closeCycle(); return }

        if (e.key === 'j') {
          e.preventDefault()
          setCycle(c => c ? { ...c, currentIdx: (c.currentIdx - 1 + CYCLE_SIZE) % CYCLE_SIZE } : c)
          return
        }
        if (e.key === 'k') {
          e.preventDefault()
          setCycle(c => c ? { ...c, currentIdx: (c.currentIdx + 1) % CYCLE_SIZE } : c)
          return
        }

        if (e.key === 'Tab') {
          e.preventDefault()
          const from = cycle.from
          closeCycle(true, false)
          requestAnimationFrame(() => {
            const found = e.shiftKey ? goNext(from) : goPrev(from)
            if (!found) restoreCursor()
          })
          return
        }

        if (e.key === ' ') {
          e.preventDefault()
          acceptSuggestion(cycle.synonyms[cycle.currentIdx], true)
          return
        }

        if (e.key === 'Enter') { e.preventDefault(); return }

        e.preventDefault()
        return
      }

      // ── No cycle ───────────────────────────────────────────────────────────
      if (e.key === 'Tab') {
        e.preventDefault()
        if (tabCursorRef.current === null) tabCursorRef.current = editor.state.selection.from
        const cursorPos = editor.state.selection.from

        if (e.shiftKey) {
          const reds = allRedWords()
          const target =
            reds.find(el => parseInt(el.dataset.para ?? '0', 10) === paragraphIndex && posOf(el) >= cursorPos) ??
            reds.find(el => posOf(el) > cursorPos)
          if (target) openCycleForElement(target)
          else tabCursorRef.current = null
        } else {
          const prev = [...allRedWords()].reverse().find(el => posOf(el) < cursorPos)
          if (prev) openCycleForElement(prev)
          else tabCursorRef.current = null
        }
      }
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [editor, cycle, paragraphIndex]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Outside click / tap ────────────────────────────────────────────────────
  useEffect(() => {
    if (!cycle) return

    function isOutside(target: HTMLElement | null) {
      return target && !target.closest?.('.scas-red') && !target.closest?.('.scas-cycle-card')
    }

    function onMouseDown(e: MouseEvent) {
      if (isOutside(e.target as HTMLElement)) closeCycle()
    }

    function onTouchStart(e: TouchEvent) {
      const touch = e.touches[0]
      if (!touch) return
      const target = document.elementFromPoint(touch.clientX, touch.clientY) as HTMLElement | null
      if (isOutside(target)) closeCycle()
    }

    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('touchstart', onTouchStart, { passive: true })
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('touchstart', onTouchStart)
    }
  }, [cycle]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Accept a suggestion ────────────────────────────────────────────────────
  function acceptSuggestion(replacement: string, advance: boolean) {
    if (!cycle) return
    const acceptedFrom = cycle.from
    const wordLen = cycle.to - cycle.from

    if (replacement === DELETE_SENTINEL) {
      // Delete the word entirely — adjust saved cursor position accordingly.
      if (tabCursorRef.current !== null && cycle.from < tabCursorRef.current) {
        tabCursorRef.current -= wordLen
      }
      onHintChange(null, null)
      editor.chain().deleteRange({ from: cycle.from, to: cycle.to }).run()
      pinCursor()
      recordAccepted()
      setCycle(null)
      if (advance) {
        requestAnimationFrame(() => {
          const found = goNext(acceptedFrom, tabCursorRef.current ?? undefined)
          if (!found) restoreCursor()
        })
      } else {
        restoreCursor()
      }
      return
    }

    const lengthDiff = replacement.length - wordLen
    if (tabCursorRef.current !== null && cycle.from < tabCursorRef.current) {
      tabCursorRef.current += lengthDiff
    }

    onHintChange(null, null)
    editor.chain()
      .deleteRange({ from: cycle.from, to: cycle.to })
      .insertContentAt(cycle.from, replacement)
      .run()
    pinCursor()

    recordAccepted()
    setCycle(null)

    if (advance) {
      requestAnimationFrame(() => {
        const found = goNext(acceptedFrom, tabCursorRef.current ?? undefined)
        if (!found) restoreCursor()
      })
    } else {
      restoreCursor()
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  if (!cycle) return null

  // Measure live from the DOM every render — correct at any zoom level.
  // The .scas-focused span already has min-width applied by the decoration,
  // so rect.width is exactly the reserved space to centre into.
  const focusedEl = editor.view.dom.querySelector('.scas-focused') as HTMLElement | null
  const cRect     = containerEl.current?.getBoundingClientRect()
  if (!focusedEl || !cRect) return null

  const rect       = focusedEl.getBoundingClientRect()
  const left       = rect.left - cRect.left
  const width      = rect.width
  const cs         = window.getComputedStyle(focusedEl)
  const fontFamily = cs.fontFamily
  const fontSize   = parseFloat(cs.fontSize) || 18

  // Use a Range over the (transparent) text to get the exact glyph bounding
  // box — this is font-metric-accurate at any zoom level, no magic offsets.
  let textMid: number
  const textNode = focusedEl.firstChild
  if (textNode && textNode.nodeType === Node.TEXT_NODE) {
    const range = document.createRange()
    range.selectNodeContents(textNode)
    const tr = range.getBoundingClientRect()
    textMid = tr.top - cRect.top + tr.height / 2
  } else {
    // Fallback: centre of the full line box
    textMid = rect.top - cRect.top + rect.height / 2
  }

  // Row height: a little taller than the glyph box so adjacent rows breathe.
  const rowLH    = Math.round(fontSize * 1.15)
  const cardPadY = 2  // must match padding-top on the card container below
  const outerLH  = Math.round(rowLH * 0.78)
  const contTop  = textMid - outerLH - rowLH / 2 - cardPadY

  const prevSynonym    = cycle.synonyms[(cycle.currentIdx - 1 + CYCLE_SIZE) % CYCLE_SIZE]
  const currentSynonym = cycle.synonyms[cycle.currentIdx]
  const nextSynonym    = cycle.synonyms[(cycle.currentIdx + 1) % CYCLE_SIZE]

  // Original word (slot 0) is shown in dark red wherever it appears so the
  // user can always track which was the old word.
  const colorFor   = (s: string) => s === cycle.synonyms[0] ? '#a02020' : '#c96a00'
  const opacityFor = (s: string) => s === cycle.synonyms[0] ? 0.92 : 0.72

  // Shared flex style keeps content vertically centred within the fixed row
  // height, so oversized glyphs (⌫ at 1.4em) can't push subsequent rows down.
  const rowBase: React.CSSProperties = {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    whiteSpace: 'nowrap', overflow: 'hidden',
  }

  return (
    <>
      {/* Glyph placeholder — vertically aligned with the middle row */}
      <div
        className="absolute z-50 pointer-events-none select-none text-stone-300"
        style={{ position: 'absolute', top: contTop + outerLH, left: left - 18,
                 lineHeight: `${rowLH}px`, fontFamily, fontSize }}
      >
        ◯
      </div>

      {/* Three-row container: prev / current / next */}
      <div
        className="absolute z-50 select-none scas-cycle-card"
        style={{
          top: contTop,
          left,
          width: Math.ceil(width),
          fontFamily,
          fontSize,
          background: 'white',
          border: '1px solid rgba(180, 90, 10, 0.85)',
          borderRadius: '10px',
          padding: `${cardPadY}px 3px`,
          boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
        }}
      >
        <div
          style={{ ...rowBase, height: outerLH, fontSize: fontSize * 0.92, color: colorFor(prevSynonym), opacity: opacityFor(prevSynonym), cursor: 'pointer' }}
          onClick={() => acceptSuggestion(prevSynonym, true)}
        >{displayFor(prevSynonym, window.innerWidth < 768 ? 1.4 : 1)}</div>
        <div
          style={{ ...rowBase, height: rowLH, color: colorFor(currentSynonym), opacity: currentSynonym === DELETE_SENTINEL ? 0.70 : 1, cursor: 'pointer' }}
          onClick={() => acceptSuggestion(currentSynonym, true)}
        >{displayFor(currentSynonym, window.innerWidth < 768 ? 1.4 : 1)}</div>
        <div
          style={{ ...rowBase, height: outerLH, fontSize: fontSize * 0.92, color: colorFor(nextSynonym), opacity: opacityFor(nextSynonym), cursor: 'pointer' }}
          onClick={() => acceptSuggestion(nextSynonym, true)}
        >{displayFor(nextSynonym, window.innerWidth < 768 ? 1.4 : 1)}</div>
      </div>
    </>
  )
}
