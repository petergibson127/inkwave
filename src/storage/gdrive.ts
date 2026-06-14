// Google Drive sync — the cross-platform cloud destination for Firefox/Safari writers (mirrors the
// OneDrive module's shape). Auth is Google Identity Services (GIS) token flow with the per-file
// `drive.file` scope: Inkwave can only ever see files IT creates — never the rest of your Drive.
// One self-contained .inkwave file per document; its Drive file id is remembered so we update (not
// duplicate) on every sync. Gated on VITE_GOOGLE_CLIENT_ID — inert until that's set.

import type { InkwaveDocument, Snapshot } from '../types/document'
import { composeTraceFile, buildExportBundle, bundleFilename } from '../provenance/bundle'

const CLIENT_ID = import.meta.env?.VITE_GOOGLE_CLIENT_ID as string | undefined
const SCOPE = 'https://www.googleapis.com/auth/drive.file'

export function googleDriveConfigured(): boolean {
  return !!CLIENT_ID
}

// ─── GIS token flow (browser-only, loaded on demand) ───────────────────────────

type TokenResponse = { access_token?: string; expires_in?: number; error?: string }
type TokenClient = { callback: (r: TokenResponse) => void; requestAccessToken: (o?: { prompt?: string }) => void }
type Gis = { accounts: { oauth2: { initTokenClient: (o: { client_id: string; scope: string; callback: (r: TokenResponse) => void }) => TokenClient } } }

let gisLoad: Promise<void> | null = null
function loadGis(): Promise<void> {
  if (gisLoad) return gisLoad
  gisLoad = new Promise((resolve, reject) => {
    if ((window as unknown as { google?: Gis }).google?.accounts?.oauth2) return resolve()
    const s = document.createElement('script')
    s.src = 'https://accounts.google.com/gsi/client'
    s.async = true
    s.defer = true
    s.onload = () => resolve()
    s.onerror = () => reject(new Error('Google Identity Services failed to load'))
    document.head.appendChild(s)
  })
  return gisLoad
}

let tokenClient: TokenClient | null = null
let cached: { token: string; expiry: number } | null = null

async function ensureClient(): Promise<TokenClient> {
  await loadGis()
  const gis = (window as unknown as { google: Gis }).google
  if (!tokenClient) {
    tokenClient = gis.accounts.oauth2.initTokenClient({ client_id: CLIENT_ID!, scope: SCOPE, callback: () => {} })
  }
  return tokenClient
}

/**
 * Get a Drive access token. interactive=true shows the Google consent popup (MUST be called from a
 * user gesture); interactive=false attempts a silent grant (only works once consented). null = no token.
 */
export async function getDriveToken(interactive: boolean): Promise<string | null> {
  if (!CLIENT_ID) return null
  if (cached && cached.expiry > Date.now() + 60_000) return cached.token
  const client = await ensureClient()
  return new Promise((resolve) => {
    client.callback = (resp) => {
      if (resp.access_token) {
        cached = { token: resp.access_token, expiry: Date.now() + (resp.expires_in ?? 3600) * 1000 }
        resolve(resp.access_token)
      } else {
        resolve(null)
      }
    }
    try {
      client.requestAccessToken({ prompt: interactive ? '' : 'none' })
    } catch {
      resolve(null)
    }
  })
}

// ─── Per-document Drive file id (so we UPDATE, never duplicate) ─────────────────

const fileKey = (docId: string) => `inkwave:gdrive-file:${docId}`
function driveFileId(docId: string): string | null {
  try { return localStorage.getItem(fileKey(docId)) } catch { return null }
}
function setDriveFileId(docId: string, id: string): void {
  try { localStorage.setItem(fileKey(docId), id) } catch { /* private mode */ }
}

const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files'

/** Forget the doc's Drive file id so the next sync creates a NEW file (used by "Save a copy"). */
export function clearGoogleDriveFile(docId: string): void {
  try { localStorage.removeItem(fileKey(docId)) } catch { /* private mode */ }
}

// The CONTAINING folder's URL (so "show in folder" reveals the surrounding files), or the file link
// as a fallback. drive.file lets us read the parents of files we created.
function folderUrl(data: { webViewLink?: string; parents?: string[] }): string | null {
  const parent = data?.parents?.[0]
  return parent ? `https://drive.google.com/drive/folders/${parent}` : (data?.webViewLink ?? null)
}

// Update the existing Drive file, or create a new one (multipart: metadata + media). Returns the
// CONTAINING folder's URL (for "show in folder"). drive.file: we only ever touch files we created.
async function uploadDrive(token: string, docId: string, name: string, content: string): Promise<string | null> {
  const existing = driveFileId(docId)
  if (existing) {
    const res = await fetch(`${UPLOAD}/${existing}?uploadType=media&fields=id,webViewLink,parents`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
      body: content,
    })
    if (res.ok) return folderUrl(await res.json())
    if (res.status !== 404) throw new Error(`Drive update failed (${res.status})`)
    // 404 → the file was deleted in Drive; fall through and create a fresh one.
  }
  const boundary = `inkwave${Math.random().toString(36).slice(2)}`
  const folder = getChosenGDriveFolder()
  const metadata = folder ? { name, parents: [folder] } : { name }
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${boundary}--`
  const res = await fetch(`${UPLOAD}?uploadType=multipart&fields=id,webViewLink,parents`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  })
  if (!res.ok) throw new Error(`Drive create failed (${res.status})`)
  const data = (await res.json()) as { id?: string; webViewLink?: string; parents?: string[] }
  if (data.id) setDriveFileId(docId, data.id)
  return folderUrl(data)
}

// ─── Chosen sync folder (global, like OneDrive) ────────────────────────────────
const FOLDER_KEY = 'inkwave:gdrive-folder'
export function getChosenGDriveFolder(): string | null {
  try { return localStorage.getItem(FOLDER_KEY) } catch { return null }
}
export function setChosenGDriveFolder(id: string | null): void {
  try { id ? localStorage.setItem(FOLDER_KEY, id) : localStorage.removeItem(FOLDER_KEY) } catch { /* private mode */ }
}

// ─── Google Picker (folder chooser) ─────────────────────────────────────────────
// drive.file can't list the user's existing folders, so we use Google's hosted Picker: it browses
// the user's Drive in Google's own UI and grants us access to the folder they select.
type Picker = { setVisible: (v: boolean) => void }
type PickerNS = {
  DocsView: new (viewId: unknown) => { setSelectFolderEnabled: (b: boolean) => any; setMimeTypes: (m: string) => any }
  ViewId: { FOLDERS: unknown }
  PickerBuilder: new () => { setOAuthToken: (t: string) => any; setDeveloperKey: (k: string) => any; addView: (v: unknown) => any; setCallback: (cb: (d: { action: string; docs?: Array<{ id: string; name: string }> }) => void) => any; build: () => Picker }
  Action: { PICKED: string; CANCEL: string; LOADED: string }
}

let pickerLoad: Promise<void> | null = null
function loadPicker(): Promise<void> {
  if (pickerLoad) return pickerLoad
  pickerLoad = new Promise((resolve, reject) => {
    const w = window as unknown as { google?: { picker?: unknown }; gapi?: { load: (m: string, o: { callback: () => void }) => void } }
    if (w.google?.picker) return resolve()
    const s = document.createElement('script')
    s.src = 'https://apis.google.com/js/api.js'
    s.async = true
    s.onload = () => w.gapi!.load('picker', { callback: () => resolve() })
    s.onerror = () => reject(new Error('Google Picker failed to load'))
    document.head.appendChild(s)
  })
  return pickerLoad
}

/** Open Google's folder Picker (interactive — call from a click); remembers + returns the choice. */
export async function pickGoogleDriveFolder(): Promise<{ id: string; name: string } | null> {
  const API_KEY = import.meta.env?.VITE_GOOGLE_API_KEY as string | undefined
  if (!CLIENT_ID || !API_KEY) return null
  const token = await getDriveToken(true)
  if (!token) return null
  await loadPicker()
  const picker = (window as unknown as { google: { picker: PickerNS } }).google.picker
  return new Promise((resolve) => {
    const view = new picker.DocsView(picker.ViewId.FOLDERS).setSelectFolderEnabled(true).setMimeTypes('application/vnd.google-apps.folder')
    // appId = the Google Cloud project NUMBER (the numeric prefix of the OAuth client id). REQUIRED
    // with the drive.file scope so the Picker can grant THIS app access to the folder you select —
    // without it, selecting a folder silently stalls.
    const appId = (CLIENT_ID ?? '').split('-')[0]
    const p = new picker.PickerBuilder()
      .setOAuthToken(token)
      .setDeveloperKey(API_KEY)
      .setAppId(appId)
      .setOrigin(`${window.location.protocol}//${window.location.host}`)
      .addView(view)
      .setCallback((data: { action: string; docs?: Array<{ id: string; name: string }> }) => {
        // The Picker does NOT reliably auto-dismiss on selection — without this the dim backdrop
        // just sits there ("goes light, doesn't progress"). Hide + tear it down on every terminal
        // action. (LOADED fires first when the dialog mounts — ignore it.)
        const action = data.action
        if (action === 'loaded' || action === picker.Action.LOADED) return
        try { p.setVisible(false) } catch { /* already gone */ }
        const doc = data.docs?.[0]
        if ((action === picker.Action.PICKED || action === 'picked') && doc) {
          setChosenGDriveFolder(doc.id)
          resolve({ id: doc.id, name: doc.name })
        } else {
          resolve(null) // cancel, or picked-with-no-doc
        }
      })
      .build()
    p.setVisible(true)
  })
}

export interface SyncResult { ok: boolean; webUrl: string | null }

/** Start sign-in / consent (interactive — call from a click). Returns true if we got a token. */
export async function startGoogleDriveSignIn(): Promise<boolean> {
  return (await getDriveToken(true)) != null
}

/** Sync the single self-contained .inkwave file to Drive using the existing grant (no UI). ok:false
 *  if not signed in / not consented — call startGoogleDriveSignIn() first. */
export async function syncToGoogleDrive(doc: InkwaveDocument, snapshots: Snapshot[]): Promise<SyncResult> {
  if (!CLIENT_ID) return { ok: false, webUrl: null }
  const token = await getDriveToken(false)
  if (!token) return { ok: false, webUrl: null }
  const file = composeTraceFile(buildExportBundle(doc, snapshots))
  try {
    return { ok: true, webUrl: await uploadDrive(token, doc.id, bundleFilename(doc), file) }
  } catch {
    return { ok: false, webUrl: null }
  }
}
