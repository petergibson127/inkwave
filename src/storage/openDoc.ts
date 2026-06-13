// Open an .inkwave (or legacy .trace.json) file as the active document and resume syncing to it.
// Shared by "Open…" (the ⋮ menu) and PWA file-handling (double-click an .inkwave file → launchQueue).
// Switches IN PLACE (no reload) so a just-granted file-write permission survives; falls back to the
// active-doc pointer so it also works when the editor isn't mounted yet (cold launch).

import { v4 as uuidv4 } from 'uuid'
import { parseTraceFile } from '../provenance/bundle'
import { saveDocument } from './opfs'
import { upsertMeta } from './indexeddb'
import { withScasDefaults } from '../scas/state'
import { setOneDriveFilename } from './onedrive'
import { setSaveFileHandle } from './folder'

const ACTIVE_DOC_KEY = 'inkwave:activeDocumentId'

export async function openInkwaveFile(file: File, handle?: FileSystemFileHandle): Promise<void> {
  const data = parseTraceFile(await file.text())
  // Accept an export bundle (content under .document) OR a raw saved document (top-level contentJson).
  const contentJson = (data as { contentJson?: typeof data.document.contentJson }).contentJson ?? data.document?.contentJson
  if (!contentJson) throw new Error('not an Inkwave file')
  const title =
    data.document?.title ??
    (data as { title?: string }).title ??
    file.name.replace(/\.(inkwave|trace\.json|insig\.json|json)$/i, '')
  const id = (data.document?.id as string | undefined) ?? uuidv4()

  setOneDriveFilename(id, file.name)              // resume OneDrive sync to this file
  if (handle) await setSaveFileHandle(id, handle) // resume local file sync (writable handle)

  const now = new Date().toISOString()
  const doc = withScasDefaults({
    id, title, contentJson, createdAt: now, updatedAt: now,
    schemaVersion: '0.1.0', scasLimitN: 'infinite', scasSessionSeed: uuidv4(),
  })
  await saveDocument(doc)
  await upsertMeta({ id, title: doc.title, updatedAt: doc.updatedAt })
  try { localStorage.setItem(ACTIVE_DOC_KEY, id) } catch { /* private mode */ }

  // With a writable handle, switch IN PLACE (no reload) so the just-granted file permission survives.
  // Without one, reload so the editor loads the doc cleanly (also covers PWA cold launch).
  if (handle) {
    window.dispatchEvent(new CustomEvent('inkwave:open-doc', { detail: { id } }))
    window.dispatchEvent(new Event('inkwave:save-file-linked'))
  } else {
    window.location.reload()
  }
}
