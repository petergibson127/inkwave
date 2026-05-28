// ThesaurusPopover — click or number-key to open, type-to-filter suggestions.
//
// Interaction model:
//   1. Click a red word, OR press its number key (shown above the word).
//      → Popover appears with up to 4 in-vocab synonym suggestions.
//   2. Press the same number key again → popover collapses (toggle).
//   3. With popover open, type letters to filter suggestions.
//      → Matched prefix is highlighted. Non-matching keystrokes are ignored.
//      → Tiptap is suppressed — nothing goes to the editor while popover is open.
//      → Enter accepts the top filtered match.
//   4. Press 1–4 to accept by position.
//   5. Esc dismisses without change.

import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { getSynonyms } from './thesaurus'
import { useCompliance } from '../../scas/compliance'
import { getActiveVocab } from '../../scas/ranking'

interface PopoverState {
  word: string
  from: number
  to: number
  suggestions: string[]
  anchor: { top: number; left: number }
  openedByKey: number | null
}

interface ThesaurusPopoverProps {
  editor: Editor
  paragraphIndex: number
  scasLimitN: number | 'infinite'
  scasSessionSeed: string
}

export function ThesaurusPopover({ editor, paragraphIndex, scasLimitN, scasSessionSeed }: ThesaurusPopoverProps) {
  const [popover, setPopover] = useState<PopoverState | null>(null)
  const [loading, setLoading] = useState(false)
  const [typeBuffer, setTypeBuffer] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)
  const { recordAccepted, recordIgnored } = useCompliance()

  const filteredSuggestions = popover
    ? typeBuffer
      ? popover.suggestions.filter((s) => s.toLowerCase().startsWith(typeBuffer))
      : popover.suggestions
    : []

  // -------------------------------------------------------------------------
  // Shared: open popover for a given .scas-red DOM element.
  // -------------------------------------------------------------------------
  function openPopoverForElement(target: HTMLElement, openedByKey: number | null = null) {
    const word = target.dataset.word ?? target.textContent ?? ''
    if (!word) return

    const view = editor.view
    const domPos = view.posAtDOM(target, 0)
    if (domPos == null) return

    const from = domPos
    const to = from + word.length

    const rect = target.getBoundingClientRect()
    const editorRect = view.dom.getBoundingClientRect()
    const anchor = {
      top: rect.bottom - editorRect.top + 6,
      left: rect.left - editorRect.left,
    }

    const paraIdx = parseInt(target.dataset.para ?? '0', 10)

    setTypeBuffer('')
    setLoading(true)
    getSynonyms(word).then((candidates) => {
      setLoading(false)
      const vocab = getActiveVocab(paraIdx, scasSessionSeed, scasLimitN)
      const suggestions = candidates
        .filter((w) => vocab.has(w.toLowerCase()))
        .slice(0, 4)
      setPopover({ word, from, to, suggestions, anchor, openedByKey })
    })
  }

  // -------------------------------------------------------------------------
  // Click handler — open popover when a red word is clicked.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!editor) return

    function onEditorClick(e: MouseEvent) {
      const target = (e.target as HTMLElement).closest('.scas-red') as HTMLElement | null
      if (!target) return
      e.preventDefault()
      openPopoverForElement(target, null)
    }

    const editorEl = editor.view.dom
    editorEl.addEventListener('click', onEditorClick)
    return () => editorEl.removeEventListener('click', onEditorClick)
  }, [editor]) // eslint-disable-line react-hooks/exhaustive-deps

  // -------------------------------------------------------------------------
  // Key handler — capture phase so we intercept before Tiptap sees the event.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!editor) return

    function onKeyDown(e: KeyboardEvent) {
      if (popover) {
        // Always swallow the event so Tiptap never sees it while popover is open.
        e.stopPropagation()

        if (e.key === 'Escape') {
          recordIgnored()
          setPopover(null)
          setTypeBuffer('')
          e.preventDefault()
          return
        }

        if (e.key === 'Enter') {
          const top = filteredSuggestions[0]
          if (top) {
            e.preventDefault()
            acceptSuggestion(top)
          }
          return
        }

        // Number key: toggle if same key, else accept by position.
        const n = parseInt(e.key, 10)
        if (!isNaN(n) && n >= 1 && n <= 9) {
          e.preventDefault()
          if (popover.openedByKey === n) {
            recordIgnored()
            setPopover(null)
            setTypeBuffer('')
          } else {
            const idx = n - 1
            if (idx < filteredSuggestions.length) {
              acceptSuggestion(filteredSuggestions[idx])
            }
          }
          return
        }

        // Space: accept only if buffer is an exact match. Otherwise reset buffer.
        if (e.key === ' ') {
          e.preventDefault()
          const exactMatch = popover.suggestions.find(
            (s) => s.toLowerCase() === typeBuffer
          )
          if (exactMatch) {
            acceptSuggestion(exactMatch)
          } else {
            setTypeBuffer('')
          }
          return
        }

        // Backspace: trim buffer.
        if (e.key === 'Backspace') {
          e.preventDefault()
          setTypeBuffer((b) => b.slice(0, -1))
          return
        }

        // Alphabetic: type-to-filter. Always preventDefault to block Tiptap.
        if (/^[a-z]$/i.test(e.key)) {
          e.preventDefault()
          const next = typeBuffer + e.key.toLowerCase()
          const hasMatch = popover.suggestions.some((s) => s.toLowerCase().startsWith(next))
          if (hasMatch) setTypeBuffer(next)
          // If no match, ignore — don't update buffer, don't insert into editor.
          return
        }

        // All other keys: prevent default to keep editor clean.
        e.preventDefault()
        return
      }

      // No popover open — number key 1–9 opens nth red word in current paragraph.
      const n = parseInt(e.key, 10)
      if (isNaN(n) || n < 1 || n > 9) return

      const editorDom = editor.view.dom
      const target = editorDom.querySelector<HTMLElement>(
        `.scas-red[data-para="${paragraphIndex}"][data-scas-n="${n}"]`
      )
      if (!target) return

      e.preventDefault()
      openPopoverForElement(target, n)
    }

    // Capture phase: fires before Tiptap's bubble-phase listeners.
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [editor, popover, typeBuffer, filteredSuggestions, paragraphIndex]) // eslint-disable-line react-hooks/exhaustive-deps

  // Dismiss on outside click.
  useEffect(() => {
    if (!popover) return
    function onMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        recordIgnored()
        setPopover(null)
        setTypeBuffer('')
      }
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [popover, recordIgnored])

  function acceptSuggestion(replacement: string) {
    if (!popover) return
    editor
      .chain()
      .focus()
      .deleteRange({ from: popover.from, to: popover.to })
      .insertContentAt(popover.from, replacement)
      .run()
    recordAccepted()
    setPopover(null)
    setTypeBuffer('')
  }

  if (!popover && !loading) return null

  return (
    <div
      ref={containerRef}
      className="absolute z-50 rounded border border-stone-200 bg-white shadow-md py-1.5 px-2 text-sm font-sans min-w-[160px]"
      style={popover ? { top: popover.anchor.top, left: popover.anchor.left } : { display: 'none' }}
    >
      {loading && (
        <div className="text-stone-400 text-xs px-1 py-0.5">Looking up&hellip;</div>
      )}
      {popover && (
        <>
          <div className="mb-1 px-1">
            <span className="text-[10px] uppercase tracking-wide text-stone-400">
              Replace &ldquo;{popover.word}&rdquo;
            </span>
          </div>

          {popover.suggestions.length === 0 ? (
            <div className="px-1.5 py-1 text-stone-400 text-xs italic">
              No in-vocab suggestions found.
            </div>
          ) : filteredSuggestions.length === 0 ? (
            <div className="px-1.5 py-1 text-stone-400 text-xs italic">
              No match for &ldquo;{typeBuffer}&rdquo;.
            </div>
          ) : (
            filteredSuggestions.map((s, i) => (
              <button
                key={s}
                className="block w-full text-left px-1.5 py-0.5 rounded hover:bg-stone-100 text-stone-700"
                onClick={() => acceptSuggestion(s)}
              >
                {typeBuffer ? (
                  <>
                    <span className="text-blue-500 font-medium">{s.slice(0, typeBuffer.length)}</span>
                    <span>{s.slice(typeBuffer.length)}</span>
                  </>
                ) : s}
              </button>
            ))
          )}

          <div className="text-[10px] text-stone-500 mt-1 px-1">esc to dismiss</div>
        </>
      )}
    </div>
  )
}
