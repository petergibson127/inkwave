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
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name })}\r\n` +
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
