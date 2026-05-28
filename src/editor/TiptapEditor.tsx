import { useEffect, useRef, useState } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import type { InkwaveDocument } from '../types/document'
import { scheduleSave } from '../storage/opfs'
import { upsertMeta } from '../storage/indexeddb'
import { RedHighlightExtension } from './extensions/RedHighlightExtension'
import { ThesaurusPopover } from './suggestions/ThesaurusPopover'
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

  const compliance = useComplianceProvider()

  const editor = useEditor({
    extensions: [
      StarterKit,
      RedHighlightExtension.configure({
        getDoc: () => docRef.current,
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

      const { $from } = e.state.selection
      let pIdx = 0
      e.state.doc.nodesBetween(0, $from.pos, (node) => {
        if (node.type.name === 'paragraph') pIdx++
      })
      setCurrentParagraphIndex(Math.max(0, pIdx - 1))
    },
  })

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
      <div className="inkwave-editor-surface min-h-screen bg-parchment px-6 py-12 md:px-0">
        <div className="mx-auto w-full max-w-[680px] relative">
          <EditorContent editor={editor} />
          {editor && (
            <ThesaurusPopover
              editor={editor}
              paragraphIndex={currentParagraphIndex}
              scasLimitN={doc.scasLimitN}
              scasSessionSeed={doc.scasSessionSeed}
            />
          )}
        </div>

        {/* Footer bar */}
        <div className="fixed bottom-0 left-0 right-0 flex justify-center pb-4 pointer-events-none">
          <div className="pointer-events-auto">
            <LimitSelector
              value={doc.scasLimitN}
              onChange={handleLimitChange}
            />
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
