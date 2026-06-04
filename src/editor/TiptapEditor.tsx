import { useEffect, useRef, useState, type RefObject } from 'react'
import { useEditor, EditorContent, Extension } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import type { InkwaveDocument } from '../types/document'
import { scheduleSave } from '../storage/opfs'
import { upsertMeta } from '../storage/indexeddb'
import { RedHighlightExtension, SCAS_HINT_META } from './extensions/RedHighlightExtension'
import type { HintState } from './extensions/RedHighlightExtension'
import { ScasSlotMark } from './extensions/ScasSlotMark'
import { ThesaurusPopover } from './suggestions/ThesaurusPopover'
import { CycleHintPanel } from './suggestions/CycleHintPanel'
import { prefetchSynonyms } from './suggestions/thesaurus'
import { LimitSelector } from '../components/LimitSelector'
import { OptionsMenu } from '../components/OptionsMenu'
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
  const [paperRight, setPaperRight] = useState(0)

  // Ref to the relative container div — passed to ThesaurusPopover for accurate positioning.
  const containerRef = useRef<HTMLDivElement>(null)
  // Ref to the parchment/scroll column — its right edge anchors the options panel.
  const paperRef = useRef<HTMLDivElement>(null)

  // Shared mutable ref read synchronously by the decoration plugin.
  const hintStateRef = useRef<HintState>({ focusedPos: null, showHints: true, focusedMinWidth: null, lineCompressionRange: null })

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

  function handleHintChange(
    pos: number | null,
    minWidth?: number | null,
    lineRange?: { from: number; to: number; letterSpacingEm: number; offsetLeft: number } | null,
  ) {
    hintStateRef.current = {
      ...hintStateRef.current,
      focusedPos: pos,
      focusedMinWidth: minWidth ?? null,
      lineCompressionRange: lineRange ?? null,
    }
    const ed = editorRef.current
    if (ed && !ed.isDestroyed) {
      ed.view.dispatch(ed.state.tr.setMeta(SCAS_HINT_META, true))
    }
  }

  const editor = useEditor({
    extensions: [
      StarterKit,
      ScasSlotMark,
      // Single Enter = hard break (stay in paragraph).
      // Double Enter (Shift+Enter) = new paragraph.
      Extension.create({
        name: 'enterBehavior',
        addKeyboardShortcuts() {
          return {
            'Enter':       () => this.editor.commands.setHardBreak(),
            'Shift-Enter': () => this.editor.chain().splitBlock().run(),
          }
        },
      }),
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
      if (paperRef.current)
        setPaperRight(paperRef.current.getBoundingClientRect().right)
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
      <div className="inkwave-editor-surface min-h-screen bg-white pt-16 pb-32 px-4">
        {/* Scroll container — slightly wider than text column */}
        <div ref={paperRef} className="mx-auto w-full max-w-[600px] md:max-w-[780px]"
          style={{
            // box-shadow (not filter: drop-shadow) so the absolutely-positioned
            // cycle card rendered inside doesn't feed its pixels into the shadow —
            // drop-shadow re-rasterises the whole parchment on every reel frame.
            borderRadius: '8px',
            boxShadow: '0 8px 32px rgba(80,50,10,0.22), 0 2px 6px rgba(80,50,10,0.18)',
          }}
        >
          {/* Top scroll head */}
          <ScrollHead position="top" />

          {/* Parchment paper body */}
          <div className="scroll-paper relative px-2 pt-10 pb-24">
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
          </div>

          {/* Bottom scroll head */}
          <ScrollHead position="bottom" />
        </div>

        <CycleHintPanel active={cycleActive} showHints={showHints} containerRight={containerRight} />

        {/* Footer bar */}
        <div className="fixed bottom-0 left-0 right-0 flex justify-center pb-4 pointer-events-none">
          <div
            className="pointer-events-auto flex items-center gap-4 bg-white px-4 py-2 shadow-sm"
            style={{ border: '1px solid rgba(92, 45, 138, 0.75)', borderRadius: '15px' }}
          >
            <LimitSelector
              value={doc.scasLimitN}
              onChange={handleLimitChange}
            />
            <label className="flex items-center gap-1.5 text-xs text-stone-400 cursor-pointer select-none font-serif">
              <input
                type="checkbox"
                checked={showHints}
                onChange={e => setShowHints(e.target.checked)}
                className="accent-stone-400"
              />
              hints
            </label>
            <span className="w-px h-5 bg-stone-200" aria-hidden="true" />
            <OptionsMenu paperRight={paperRight} />
          </div>
        </div>
      </div>
    </ComplianceContext.Provider>
  )
}

function ScrollHead({ position }: { position: 'top' | 'bottom' }) {
  const isTop  = position === 'top'
  const brOuter = isTop ? '8px 8px 0 0' : '0 0 8px 8px'
  const brL     = isTop ? '8px 0 0 0'   : '0 0 0 8px'
  const brR     = isTop ? '0 8px 0 0'   : '0 0 8px 0'

  return (
    <div
      aria-hidden="true"
      style={{
        height: '36px',
        width: '100%',
        position: 'relative',
        borderRadius: brOuter,
        overflow: 'hidden',
        // Cylinder gradient: very dark top edge → warm wood → bright highlight band → lit face → darkening back → very dark bottom edge
        background: 'linear-gradient(to bottom, #160901 0%, #5a2e06 5%, #a86018 13%, #d99430 22%, #f8d060 30%, #fce070 36%, #eab030 46%, #b87020 58%, #7a4010 72%, #3e1e06 86%, #140800 100%)',
      }}
    >
      {/* Subtle horizontal wood grain */}
      <div style={{
        position: 'absolute', inset: 0, borderRadius: brOuter,
        backgroundImage: 'repeating-linear-gradient(to bottom, transparent 0px, transparent 4px, rgba(0,0,0,0.045) 4px, rgba(0,0,0,0.045) 5px)',
      }} />

      {/* Primary glint — bright highlight near the top of the curve */}
      <div style={{
        position: 'absolute',
        top: '22%', left: '8%', right: '8%', height: '16%',
        background: 'linear-gradient(to right, transparent, rgba(255,253,225,0.72) 22%, rgba(255,255,248,0.94) 50%, rgba(255,253,225,0.72) 78%, transparent)',
        borderRadius: '6px',
      }} />

      {/* Soft secondary reflection on the lower curve */}
      <div style={{
        position: 'absolute',
        bottom: '16%', left: '20%', right: '20%', height: '8%',
        background: 'linear-gradient(to right, transparent, rgba(215,155,45,0.24) 50%, transparent)',
        borderRadius: '4px',
      }} />

      {/* Left end-cap — multi-stop dark wedge simulating the cylinder turning at the edge */}
      <div style={{
        position: 'absolute', top: 0, left: 0, bottom: 0, width: '36px',
        background: 'linear-gradient(to right, rgba(6,2,0,0.92) 0px, rgba(18,7,0,0.68) 8px, rgba(35,14,0,0.35) 20px, transparent 36px)',
        borderRadius: brL,
      }} />

      {/* Right end-cap */}
      <div style={{
        position: 'absolute', top: 0, right: 0, bottom: 0, width: '36px',
        background: 'linear-gradient(to left, rgba(6,2,0,0.92) 0px, rgba(18,7,0,0.68) 8px, rgba(35,14,0,0.35) 20px, transparent 36px)',
        borderRadius: brR,
      }} />

      {/* Paper-contact shadow — parchment wraps tightly around the roller here */}
      <div style={{
        position: 'absolute',
        ...(isTop ? { bottom: 0 } : { top: 0 }),
        left: 0, right: 0, height: '10px',
        background: isTop
          ? 'linear-gradient(to top, rgba(0,0,0,0.52), transparent)'
          : 'linear-gradient(to bottom, rgba(0,0,0,0.52), transparent)',
      }} />
    </div>
  )
}

function deriveTitle(text: string): string {
  const first = text.trim().split('\n')[0]?.trim() ?? ''
  return first.slice(0, 80)
}
