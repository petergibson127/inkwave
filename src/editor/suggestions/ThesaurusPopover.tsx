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

import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { getSynonyms } from './thesaurus'
import { useCompliance } from '../../scas/compliance'
import { getFont, measureTextWidth } from './textMetrics'

const CYCLE_SIZE = 8
// Sentinel stored in the synonyms array to represent "delete this word".
const DELETE_SENTINEL = '\x00delete'
const DELETE_DISPLAY  = '⌫'

function displayFor(s: string): string {
  return s === DELETE_SENTINEL ? DELETE_DISPLAY : s
}

// ── Types ─────────────────────────────────────────────────────────────────────
interface CycleState {
  word: string
  from: number
  to: number
  synonyms: string[]   // exactly CYCLE_SIZE entries
  currentIdx: number
  // No pre-computed anchor — positions are read live from the DOM in render
  // so they stay correct across zoom changes.
}

interface ThesaurusPopoverProps {
  editor: Editor
  paragraphIndex: number
  containerEl: React.RefObject<HTMLDivElement>
  onHintChange: (pos: number | null, minWidth?: number | null) => void
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

    // Capture geometry BEFORE the async getSynonyms call.
    const rect = target.getBoundingClientRect()
    const containerRect = containerEl.current?.getBoundingClientRect()
      ?? editor.view.dom.getBoundingClientRect()
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

  // ── Click / touch handler ──────────────────────────────────────────────────
  useEffect(() => {
    if (!editor) return
    const editorEl = editor.view.dom

    // Intercept mousedown on red words to prevent the browser moving the cursor.
    function onMouseDown(e: MouseEvent) {
      if ((e.target as HTMLElement).closest('.scas-red')) e.preventDefault()
    }

    // Click opens (or switches) the cycle without cursor movement.
    function onEditorClick(e: MouseEvent) {
      const target = (e.target as HTMLElement).closest('.scas-red') as HTMLElement | null
      if (!target) return
      e.preventDefault()
      tabCursorRef.current = null
      openCycleForElement(target)
    }

    // Touch: open cycle on tap, suppress the synthetic mouse events that follow.
    function onTouchEnd(e: TouchEvent) {
      const target = (e.target as HTMLElement).closest('.scas-red') as HTMLElement | null
      if (!target) return
      e.preventDefault()
      tabCursorRef.current = null
      openCycleForElement(target)
    }

    editorEl.addEventListener('mousedown', onMouseDown, { capture: true })
    editorEl.addEventListener('click',     onEditorClick, { capture: true })
    editorEl.addEventListener('touchend',  onTouchEnd,    { capture: true })
    return () => {
      editorEl.removeEventListener('mousedown', onMouseDown, { capture: true })
      editorEl.removeEventListener('click',     onEditorClick, { capture: true })
      editorEl.removeEventListener('touchend',  onTouchEnd,    { capture: true })
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

  // ── Outside click ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!cycle) return
    function onMouseDown(e: MouseEvent) {
      const target = e.target as HTMLElement
      if (!target.closest?.('.scas-red') && !target.closest?.('.scas-cycle-card')) closeCycle()
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
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
  const contTop  = textMid - rowLH * 1.5 - cardPadY

  const prevSynonym    = cycle.synonyms[(cycle.currentIdx - 1 + CYCLE_SIZE) % CYCLE_SIZE]
  const currentSynonym = cycle.synonyms[cycle.currentIdx]
  const nextSynonym    = cycle.synonyms[(cycle.currentIdx + 1) % CYCLE_SIZE]

  const rowStyle = {
    lineHeight: `${rowLH}px`,
    whiteSpace: 'nowrap' as const,
    textAlign: 'center' as const,
  }

  return (
    <>
      {/* Glyph placeholder — vertically aligned with the middle row */}
      <div
        className="absolute z-50 pointer-events-none select-none text-stone-300"
        style={{ position: 'absolute', top: contTop + rowLH, left: left - 18,
                 lineHeight: `${rowLH}px`, fontFamily, fontSize }}
      >
        ◯
      </div>

      {/* Three-row container: prev / current / next, centred in the reserved space */}
      <div
        className="absolute z-50 select-none scas-cycle-card"
        style={{
          top: contTop,
          left,
          width: Math.ceil(width),
          fontFamily,
          fontSize,
          background: 'white',
          border: '1px solid rgba(210, 140, 60, 0.6)',
          borderRadius: '15%',
          padding: `${cardPadY}px 3px`,
          boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
        }}
      >
        <div
          style={{ ...rowStyle, color: '#7c3300', opacity: 0.45, cursor: 'pointer' }}
          onClick={() => acceptSuggestion(prevSynonym, true)}
        >{displayFor(prevSynonym)}</div>
        <div style={{ ...rowStyle, color: '#c96a00', opacity: currentSynonym === DELETE_SENTINEL ? 0.30 : 1, pointerEvents: 'none' }}>{displayFor(currentSynonym)}</div>
        <div
          style={{ ...rowStyle, color: '#7c3300', opacity: 0.45, cursor: 'pointer' }}
          onClick={() => acceptSuggestion(nextSynonym, true)}
        >{displayFor(nextSynonym)}</div>
      </div>
    </>
  )
}
