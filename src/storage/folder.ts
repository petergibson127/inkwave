// Writer-held folder storage (v4 spec §5/§11, M4). "The folder IS the login" for the free tiers:
// the writer grants a directory once; we persist the handle and mirror their work into it
// (current doc + snapshots + the self-verifying export bundle) so it lives in a place they control
// (point it at any cloud-synced folder and their OS handles cross-device sync). Chromium-only;
// other browsers fall back to OPFS + the manual export download.
//
// The granted handle is stored in IndexedDB (FileSystemDirectoryHandle is structured-cloneable).
// On return we re-check permission (queryPermission/requestPermission).

import type { InkwaveDocument, Snapshot } from '../types/document'
import { buildExportBundle, bundleFilename } from '../provenance/bundle'

// Minimal IDB store for the single granted folder handle (separate from the doc-metadata DB).
const DB_NAME = 'inkwave-folder'
const STORE = 'handles'
const KEY = 'granted'

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await idb()
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
    r.onsuccess = () => resolve(r.result as T | undefined)
    r.onerror = () => reject(r.error)
  })
}
async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await idb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}
async function idbDel(key: string): Promise<void> {
  const db = await idb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

// FileSystemDirectoryHandle has permission methods not in the base TS lib types.
type DirHandle = FileSystemDirectoryHandle & {
  queryPermission?: (d: { mode: string }) => Promise<PermissionState>
  requestPermission?: (d: { mode: string }) => Promise<PermissionState>
}

/** Is the File System Access folder API available (Chromium)? */
export function folderApiAvailable(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window
}

/** Prompt the writer to grant a folder (a user gesture), persist the handle, and return it. */
export async function grantFolder(): Promise<FileSystemDirectoryHandle | null> {
  if (!folderApiAvailable()) return null
  try {
    const handle = await (window as unknown as {
      showDirectoryPicker: (o: { mode: string }) => Promise<FileSystemDirectoryHandle>
    }).showDirectoryPicker({ mode: 'readwrite' })
    await idbSet(KEY, handle)
    return handle
  } catch {
    return null // user cancelled
  }
}

/** Return the previously-granted folder if permission is (re-)granted; else null. */
export async function getGrantedFolder(interactive = false): Promise<FileSystemDirectoryHandle | null> {
  if (!folderApiAvailable()) return null
  const handle = await idbGet<DirHandle>(KEY)
  if (!handle) return null
  try {
    const opts = { mode: 'readwrite' }
    if ((await handle.queryPermission?.(opts)) === 'granted') return handle
    if (interactive && (await handle.requestPermission?.(opts)) === 'granted') return handle
  } catch { /* handle stale */ }
  return null
}

export async function forgetFolder(): Promise<void> {
  await idbDel(KEY)
}

async function writeFile(dir: FileSystemDirectoryHandle, name: string, data: string): Promise<void> {
  const fh = await dir.getFileHandle(name, { create: true })
  const w = await fh.createWritable()
  await w.write(data)
  await w.close()
}

/**
 * Mirror the document into the granted folder: the current content, the snapshots, and the
 * self-verifying export bundle (so the writer's own folder always holds a record they can hand to a
 * verifier). No-op if no folder is granted.
 */
export async function mirrorDocument(doc: InkwaveDocument, snapshots: Snapshot[]): Promise<boolean> {
  const folder = await getGrantedFolder()
  if (!folder) return false
  try {
    const dir = await folder.getDirectoryHandle('inkwave', { create: true })
    await writeFile(dir, `${doc.id}.current.json`, JSON.stringify(doc))
    await writeFile(dir, `${doc.id}.snapshots.json`, JSON.stringify(snapshots))
    await writeFile(dir, bundleFilename(doc), JSON.stringify(buildExportBundle(doc, snapshots), null, 2))
    return true
  } catch {
    return false // permission lost / disk error — caller keeps OPFS as source of truth
  }
}
