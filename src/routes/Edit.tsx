import { useEffect, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'
import { TiptapEditor } from '../editor/TiptapEditor'
import { Scroll, EmptyEditorSurface, isTouchDevice } from '../editor/Scroll'
import type { InkwaveDocument } from '../types/document'
import { loadDocument, emptyTiptapDoc } from '../storage/opfs'
import { listMeta } from '../storage/indexeddb'
import { withScasDefaults } from '../scas/state'

// The active document ID is persisted in localStorage so the same document
// reopens on refresh. (Content itself is in OPFS — this is just the pointer.)
const ACTIVE_DOC_KEY = 'inkwave:activeDocumentId'

function newDocument(): InkwaveDocument {
  return withScasDefaults({
    id: uuidv4(),
    title: 'Untitled',
    contentJson: emptyTiptapDoc(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    schemaVersion: '0.1.0',
    scasLimitN: 'infinite',
    scasSessionSeed: uuidv4(),
  })
}

// Fill in fields for documents saved before they existed (incl. the SCAS engine state).
function migrateDocument(doc: InkwaveDocument): InkwaveDocument {
  return withScasDefaults(Object.assign({ scasLimitN: 'infinite', scasSessionSeed: uuidv4() }, doc))
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
        // Never strand the writer on the blank placeholder. Fall back to a fresh
        // in-memory document under a NEW id, so no existing file is ever overwritten.
        // localStorage can throw (private mode), so guard it on its own.
        const fresh = newDocument()
        try { localStorage.setItem(ACTIVE_DOC_KEY, fresh.id) } catch { /* private mode */ }
        setDoc(fresh)
      }
    }

    void init()
  }, [])

  function handleDocChange(updated: InkwaveDocument) {
    setDoc(updated)
  }

  // Before the document loads (and during prerender, where effects never run) render the SHARED
  // empty-editor shell — the same Scroll chrome + an empty .ProseMirror facsimile the live
  // editor uses. So the prerendered landing page is a direct CSS function of the editor, and the
  // real editor mounts in its place with no visual jump.
  if (!doc) {
    return (
      <Scroll phone={isTouchDevice()}>
        <EmptyEditorSurface />
      </Scroll>
    )
  }

  return <TiptapEditor doc={doc} onDocChange={handleDocChange} />
}
