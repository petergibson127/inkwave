import { useEffect, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { TiptapEditor } from '../editor/TiptapEditor'
import type { InkwaveDocument } from '../types/document'
import { loadDocument, emptyTiptapDoc } from '../storage/opfs'
import { listMeta } from '../storage/indexeddb'

// The active document ID is persisted in localStorage so the same document
// reopens on refresh. (Content itself is in OPFS — this is just the pointer.)
const ACTIVE_DOC_KEY = 'inkwave:activeDocumentId'

function newDocument(): InkwaveDocument {
  return {
    id: uuidv4(),
    title: 'Untitled',
    contentJson: emptyTiptapDoc(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    schemaVersion: '0.1.0',
    scasLimitN: 'infinite',
    scasSessionSeed: uuidv4(),
  }
}

// Fill in Week 2 fields for documents saved before they existed.
function migrateDocument(doc: InkwaveDocument): InkwaveDocument {
  return {
    scasLimitN: 'infinite',
    scasSessionSeed: uuidv4(),
    ...doc,
  }
}

export function Edit() {
  const [doc, setDoc] = useState<InkwaveDocument | null>(null)

  useEffect(() => {
    async function init() {
      try {
        // 1. Try to restore the last active document from OPFS.
        const storedId = localStorage.getItem(ACTIVE_DOC_KEY)
        if (storedId) {
          const loaded = await loadDocument(storedId)
          if (loaded) {
            setDoc(migrateDocument(loaded))
            return
          }
        }

        // 2. Fall back to the most recently updated document in IndexedDB.
        const metas = await listMeta()
        if (metas.length > 0) {
          const loaded = await loadDocument(metas[0].id)
          if (loaded) {
            localStorage.setItem(ACTIVE_DOC_KEY, loaded.id)
            setDoc(migrateDocument(loaded))
            return
          }
        }

        // 3. Create a fresh document.
        const fresh = newDocument()
        localStorage.setItem(ACTIVE_DOC_KEY, fresh.id)
        setDoc(fresh)
      } catch (err) {
        console.error('[inkwave] init failed:', err)
      }
    }

    void init()
  }, [])

  function handleDocChange(updated: InkwaveDocument) {
    setDoc(updated)
  }

  if (!doc) {
    return <div className="min-h-screen bg-parchment" />
  }

  return (
    <div className="relative min-h-screen bg-parchment">
      <TiptapEditor doc={doc} onDocChange={handleDocChange} />
    </div>
  )
}
