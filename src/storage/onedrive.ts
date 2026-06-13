// OneDrive sync via Microsoft Graph (cross-browser cloud storage). File System Access is
// Chromium-only, so this gives Firefox/Safari writers (and anyone) a way to sync their record to
// OneDrive: sign in with a Microsoft account (OAuth 2.0 PKCE via MSAL), then PUT the files into the
// app's OneDrive folder (OneDrive/Apps/Inkwave) with the least-privilege Files.ReadWrite.AppFolder
// scope. Only an access token + the file bytes leave the browser, straight to Microsoft Graph — no
// Inkwave server is involved.
//
// Requires an Azure app registration (a public SPA client id) in VITE_MS_CLIENT_ID; the feature is
// hidden until that's configured. MSAL is lazily imported so it's a separate client chunk and never
// enters the prerender/SSR graph.

import type { InkwaveDocument, Snapshot } from '../types/document'
import { buildExportBundle, bundleFilename, composeTraceFile } from '../provenance/bundle'

// The OneDrive folder the writer chose to sync into. id '' (or null) = the OneDrive root. `path` is
// a human-readable location ("Documents/Inkwave") for display. Persisted so the choice sticks.
export interface OneDriveFolder { id: string; path: string }
const FOLDER_KEY = 'inkwave:onedrive-folder'

export function getChosenFolder(): OneDriveFolder | null {
  try { const s = localStorage.getItem(FOLDER_KEY); return s ? (JSON.parse(s) as OneDriveFolder) : null } catch { return null }
}
export function setChosenFolder(folder: OneDriveFolder | null): void {
  try { folder ? localStorage.setItem(FOLDER_KEY, JSON.stringify(folder)) : localStorage.removeItem(FOLDER_KEY) } catch { /* private mode */ }
}

/** Where the synced file lives in the user's OneDrive (for display), honouring the chosen folder. */
export function oneDrivePath(doc: InkwaveDocument): string {
  const folder = getChosenFolder()
  const prefix = folder?.path ? `${folder.path}/` : ''
  return `${prefix}${bundleFilename(doc)}`
}

// The Azure app (SPA) client id — PUBLIC (it appears in OAuth redirects), so it's committed as the
// default and overridable via VITE_MS_CLIENT_ID. Redirect URIs registered: https://www.inkwave.studio
// + http://localhost:5173 (dev). Authority /common + delegated Files.ReadWrite.AppFolder.
const CLIENT_ID = (import.meta.env?.VITE_MS_CLIENT_ID as string | undefined) || 'be76cc89-ab01-4681-99c0-f37b9f9d2308'
// Personal + work/school accounts. Files.ReadWrite (full drive) so the writer can pick ANY folder
// to sync into; existing AppFolder-only sessions are re-prompted to consent on the next sync.
const AUTHORITY = 'https://login.microsoftonline.com/common'
const SCOPES = ['Files.ReadWrite', 'User.Read']
const GRAPH = 'https://graph.microsoft.com/v1.0'

/** Is OneDrive sync configured (an Azure client id is present)? */
export function oneDriveConfigured(): boolean {
  return !!CLIENT_ID
}

// MSAL is browser-only and heavy — load it on demand.
let appPromise: Promise<unknown> | null = null
async function getApp(): Promise<{
  getAllAccounts: () => Array<{ username: string }>
  acquireTokenSilent: (o: unknown) => Promise<{ accessToken: string }>
  loginRedirect: (o: unknown) => Promise<void>
}> {
  if (!CLIENT_ID) throw new Error('OneDrive not configured')
  if (!appPromise) {
    appPromise = import('@azure/msal-browser').then(async (m) => {
      const app = new m.PublicClientApplication({
        auth: { clientId: CLIENT_ID, authority: AUTHORITY, redirectUri: window.location.origin },
        cache: { cacheLocation: 'localStorage' },
      })
      await app.initialize()
      // Same-window flow: process the auth response when we return from the Microsoft redirect.
      await app.handleRedirectPromise()
      return app
    })
  }
  return appPromise as Promise<Awaited<ReturnType<typeof getApp>>>
}

/** The signed-in Microsoft account's username/email, or null. */
export async function oneDriveAccount(): Promise<string | null> {
  if (!CLIENT_ID) return null
  try {
    const app = await getApp()
    return app.getAllAccounts()[0]?.username ?? null
  } catch {
    return null
  }
}

// Silent access token (an existing session only — no UI). null if not signed in / expired.
// Exported so the folder picker can call Graph directly.
export async function getSilentToken(): Promise<string | null> {
  const app = await getApp()
  const account = app.getAllAccounts()[0]
  if (!account) return null
  try {
    return (await app.acquireTokenSilent({ scopes: SCOPES, account })).accessToken
  } catch {
    return null
  }
}

const PENDING_KEY = 'inkwave:onedrive-pending'

/** Begin sign-in in the SAME window (full-page redirect to Microsoft and back). Flags that a sync
 *  is wanted on return. The page navigates away; work is restored from OPFS when it comes back. */
export async function startOneDriveSignIn(): Promise<void> {
  if (!CLIENT_ID) return
  try { sessionStorage.setItem(PENDING_KEY, '1') } catch { /* private mode */ }
  const app = await getApp()
  await app.loginRedirect({ scopes: SCOPES })
}

/** True if we just returned from a sign-in redirect and should sync now. */
export function oneDriveSyncPending(): boolean {
  try { return sessionStorage.getItem(PENDING_KEY) === '1' } catch { return false }
}
export function clearOneDriveSyncPending(): void {
  try { sessionStorage.removeItem(PENDING_KEY) } catch { /* ignore */ }
}

// PUT the file into the chosen folder (or the OneDrive root). Returns the file's webUrl so the UI
// can offer "open in OneDrive". Graph addresses items by path relative to a folder id, or to root.
async function putFile(token: string, name: string, content: string): Promise<string | null> {
  const folder = getChosenFolder()
  const target = folder?.id
    ? `${GRAPH}/me/drive/items/${folder.id}:/${encodeURIComponent(name)}:/content`
    : `${GRAPH}/me/drive/root:/${encodeURIComponent(name)}:/content`
  const res = await fetch(target, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
    body: content,
  })
  if (!res.ok) throw new Error(`Graph upload failed (${res.status})`)
  const data = await res.json().catch(() => ({} as { webUrl?: string }))
  return (data as { webUrl?: string }).webUrl ?? null
}

export interface DriveFolder { id: string; name: string }

/** List the sub-folders of a folder (null/'' = OneDrive root) for the folder picker. */
export async function listFolders(parentId: string | null): Promise<DriveFolder[]> {
  const token = await getSilentToken()
  if (!token) throw new Error('not signed in')
  const base = parentId ? `${GRAPH}/me/drive/items/${parentId}/children` : `${GRAPH}/me/drive/root/children`
  const res = await fetch(`${base}?$select=id,name,folder&$top=200&$orderby=name`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Graph list failed (${res.status})`)
  const data = (await res.json()) as { value: Array<{ id: string; name: string; folder?: unknown }> }
  return data.value.filter((it) => it.folder).map((it) => ({ id: it.id, name: it.name }))
}

export interface SyncResult { ok: boolean; webUrl: string | null }

/**
 * Sync the single self-contained .trace.json to the chosen OneDrive folder using the existing session
 * (no UI). ok:false if not signed in / the scope isn't consented — call startOneDriveSignIn() first.
 */
export async function syncToOneDrive(doc: InkwaveDocument, snapshots: Snapshot[]): Promise<SyncResult> {
  if (!CLIENT_ID) return { ok: false, webUrl: null }
  const token = await getSilentToken()
  if (!token) return { ok: false, webUrl: null }
  // One self-contained file: readable writing on top, then the record (content + snapshots + Bitcoin
  // proofs + receipts).
  const file = composeTraceFile(buildExportBundle(doc, snapshots))
  try {
    return { ok: true, webUrl: await putFile(token, bundleFilename(doc), file) }
  } catch {
    return { ok: false, webUrl: null }
  }
}
