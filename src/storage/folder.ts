// Single-file local save (M4). The writer saves ONE self-contained <name>.trace.json (content +
// snapshots + Bitcoin proofs + signed receipts, with the readable text header on top) to a name +
// location THEY choose, via the File System Access "save file" picker. The handle is persisted so
// subsequent auto-saves write back to the same file. Chromium only; other browsers fall back to a
// download (and/or OneDrive).

import type { InkwaveDocument, Snapshot } from '../types/document'
import { buildExportBundle, bundleFilename, composeTraceFile, parseTraceFile } from '../provenance/bundle'

const DB_NAME = 'inkwave-folder'
const STORE = 'handles'
const KEY = 'savefile'

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE) }
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

type FileHandle = FileSystemFileHandle & {
  queryPermission?: (d: { mode: string }) => Promise<PermissionState>
  requestPermission?: (d: { mode: string }) => Promise<PermissionState>
}

/** Is the File System Access "save file" picker available (Chromium)? */
export function fileSaveAvailable(): boolean {
  return typeof window !== 'undefined' && 'showSaveFilePicker' in window
}

/** Prompt the writer to choose a name + location for their single .trace.json (a user gesture);
 *  persist the handle and return it. */
export async function pickSaveFile(doc: InkwaveDocument): Promise<FileSystemFileHandle | null> {
  if (!fileSaveAvailable()) return null
  try {
    const handle = await (window as unknown as {
      showSaveFilePicker: (o: unknown) => Promise<FileSystemFileHandle>
    }).showSaveFilePicker({ suggestedName: bundleFilename(doc) })
    await idbSet(KEY, handle)
    return handle
  } catch {
    return null // cancelled
  }
}

/** The previously-chosen save file if permission is (re-)granted; else null. */
export async function getSaveFileHandle(interactive = false): Promise<FileHandle | null> {
  if (!fileSaveAvailable()) return null
  const handle = await idbGet<FileHandle>(KEY)
  if (!handle) return null
  try {
    const opts = { mode: 'readwrite' }
    if ((await handle.queryPermission?.(opts)) === 'granted') return handle
    if (interactive && (await handle.requestPermission?.(opts)) === 'granted') return handle
  } catch { /* stale handle */ }
  return null
}

export async function forgetSaveFile(): Promise<void> {
  await idbDel(KEY)
}

/** Read back the saved file's heartbeat (which device last wrote it, and when) for the multi-device
 *  guard. null if no file / unreadable. */
export async function readLocalHeartbeat(): Promise<{ session?: string; exportedAt?: string } | null> {
  const handle = await getSaveFileHandle(false)
  if (!handle) return null
  try {
    const text = await (await handle.getFile()).text()
    const bundle = parseTraceFile(text)
    return { session: bundle.session, exportedAt: bundle.exportedAt }
  } catch {
    return null
  }
}

/** Write the current bundle to the chosen file (silent — no prompt). Returns true on success. */
export async function writeBundleToFile(doc: InkwaveDocument, snapshots: Snapshot[]): Promise<boolean> {
  const handle = await getSaveFileHandle(false)
  if (!handle) return false
  try {
    const writable = await handle.createWritable()
    await writable.write(composeTraceFile(buildExportBundle(doc, snapshots)))
    await writable.close()
    return true
  } catch {
    return false
  }
}
