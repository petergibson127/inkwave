import { useEffect, useRef, useState, type RefObject } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import type { InkwaveDocument } from '../types/document'
import { scheduleSave } from '../storage/opfs'
import { upsertMeta } from '../storage/indexeddb'
import { RedHighlightExtension, SCAS_HINT_META } from './extensions/RedHighlightExtension'
import type { HintState } from './extensions/RedHighlightExtension'
import { ThesaurusPopover } from './suggestions/ThesaurusPopover'
import { CycleHintPanel } from './suggestions/CycleHintPanel'
import { prefetchSynonyms } from './suggestions/thesaurus'
import { LimitSelector } from '../components/LimitSelector'
import { ComplianceContext, useComplianceProvider } from '../scas/compliance'

interface TiptapEditorProps {
  doc: InkwaveDocument
  onDocChange: (updated: InkwaveDocument) => void
}

export function TiptapEditor({ doc, onDocChange }: TiptapEditorProps) {
  const docRef = useRef(doc)
  useEffect(() => {
    docRef.current = doc
  }, [doc])

  const [currentParagraphIndex, setCurrentParagraphIndex] = useState(0)
  const [showHints, setShowHints] = useState(true)
  const [cycleActive, setCycleActive] = useState(false)
  const [containerRight, setContainerRight] = useState(0)

  // Ref to the relative container div — passed to ThesaurusPopover for accurate positioning.
  const containerRef = useRef<HTMLDivElement>(null)

  // Shared mutable ref read synchronously by the decoration plugin.
  const hintStateRef = useRef<HintState>({ focusedPos: null, showHints: true, focusedMinWidth: null })

  // Debounced prefetch — fires after typing pauses so popover opens instantly.
  const prefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const compliance = useComplianceProvider()

  // Keep showHints in sync with the ref and force a decoration rebuild.
  const editorRef = useRef<ReturnType<typeof useEditor>>(null)
  useEffect(() => {
    hintStateRef.current = { ...hintStateRef.current, showHints }
    const ed = editorRef.current
    if (ed && !ed.isDestroyed) {
      ed.view.dispatch(ed.state.tr.setMeta(SCAS_HINT_META, true))
    }
  }, [showHints])

  function handleHintChange(pos: number | null, minWidth?: number | null) {
    hintStateRef.current = {
      ...hintStateRef.current,
      focusedPos: pos,
      focusedMinWidth: minWidth ?? null,
    }
    const ed = editorRef.current
    if (ed && !ed.isDestroyed) {
      ed.view.dispatch(ed.state.tr.setMeta(SCAS_HINT_META, true))
    }
  }

  const editor = useEditor({
    extensions: [
      StarterKit,
      RedHighlightExtension.configure({
        getDoc: () => docRef.current,
        getHintState: () => hintStateRef.current,
      }),
    ],
    content: doc.contentJson,
    editorProps: {
      attributes: {
        class: 'tiptap-editor',
        'data-placeholder': 'Begin writing…',
        spellcheck: 'false',
      },
    },
    onTransaction: ({ editor: e }) => {
      const current = docRef.current
      const updated: InkwaveDocument = {
        ...current,
        contentJson: e.getJSON(),
        updatedAt: new Date().toISOString(),
        title: deriveTitle(e.getText()) || current.title,
      }
      docRef.current = updated
      onDocChange(updated)
      scheduleSave(updated)
      void upsertMeta({
        id: updated.id,
        title: updated.title,
        updatedAt: updated.updatedAt,
      })

      // Prefetch synonyms for all visible red words after a short pause.
      if (prefetchTimerRef.current) clearTimeout(prefetchTimerRef.current)
      prefetchTimerRef.current = setTimeout(() => {
        const words = Array.from(
          e.view.dom.querySelectorAll<HTMLElement>('.scas-red')
        ).map(el => el.dataset.word ?? '').filter(Boolean)
        if (words.length > 0) prefetchSynonyms([...new Set(words)])
      }, 600)

      const { $from } = e.state.selection
      let pIdx = 0
      e.state.doc.nodesBetween(0, $from.pos, (node) => {
        if (node.type.name === 'paragraph') pIdx++
      })
      setCurrentParagraphIndex(Math.max(0, pIdx - 1))
    },
  })

  // Keep editorRef in sync so the hint-change handler can reach the editor.
  useEffect(() => {
    editorRef.current = editor
  }, [editor])

  // Track the container's right edge in viewport coords so CycleHintPanel
  // can sit flush against it at any window size or zoom level.
  useEffect(() => {
    function update() {
      if (containerRef.current)
        setContainerRight(containerRef.current.getBoundingClientRect().right)
    }
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  // Warm the synonym cache as soon as the editor is ready (existing red words).
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    requestAnimationFrame(() => {
      const words = Array.from(
        editor.view.dom.querySelectorAll<HTMLElement>('.scas-red')
      ).map(el => el.dataset.word ?? '').filter(Boolean)
      if (words.length > 0) prefetchSynonyms([...new Set(words)])
    })
  }, [editor]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    const currentContent = JSON.stringify(editor.getJSON())
    const incomingContent = JSON.stringify(doc.contentJson)
    if (currentContent !== incomingContent) {
      editor.commands.setContent(doc.contentJson, false)
    }
  }, [doc.id, editor]) // eslint-disable-line react-hooks/exhaustive-deps

  function handleLimitChange(next: number | 'infinite') {
    const updated: InkwaveDocument = {
      ...docRef.current,
      scasLimitN: next,
      updatedAt: new Date().toISOString(),
    }
    docRef.current = updated
    onDocChange(updated)
    scheduleSave(updated)
    editor?.commands.focus()
  }

  return (
    <ComplianceContext.Provider value={compliance}>
      <div className="inkwave-editor-surface min-h-screen bg-parchment pl-2 pr-5 pt-10 pb-24">
        <div className="mx-auto w-full max-w-[560px] md:max-w-[720px] relative" ref={containerRef}>
          <EditorContent editor={editor} />
          {editor && (
            <ThesaurusPopover
              editor={editor}
              paragraphIndex={currentParagraphIndex}
              containerEl={containerRef as RefObject<HTMLDivElement>}
              onHintChange={handleHintChange}
              onCycleChange={setCycleActive}
            />
          )}
        </div>

        <CycleHintPanel active={cycleActive} showHints={showHints} containerRight={containerRight} />

        {/* Footer bar */}
        <div className="fixed bottom-0 left-0 right-0 flex justify-center pb-4 pointer-events-none">
          <div
            className="pointer-events-auto flex items-center gap-4 bg-white px-4 py-2 shadow-sm"
            style={{ border: '1px solid rgba(180, 90, 10, 0.85)', borderRadius: '15px' }}
          >
            <LimitSelector
              value={doc.scasLimitN}
              onChange={handleLimitChange}
            />
            <label className="flex items-center gap-1.5 text-xs text-stone-400 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showHints}
                onChange={e => setShowHints(e.target.checked)}
                className="accent-stone-400"
              />
              hints
            </label>
          </div>
        </div>
      </div>
    </ComplianceContext.Provider>
  )
}

function deriveTitle(text: string): string {
  const first = text.trim().split('\n')[0]?.trim() ?? ''
  return first.slice(0, 80)
}
