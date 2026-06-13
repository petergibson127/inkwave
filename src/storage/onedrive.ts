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
import { buildExportBundle, bundleFilename } from '../provenance/bundle'

/** Where the synced file lives in the user's OneDrive (for display). */
export function oneDrivePath(doc: InkwaveDocument): string {
  return `Apps/Inkwave/${bundleFilename(doc)}`
}

// The Azure app (SPA) client id — PUBLIC (it appears in OAuth redirects), so it's committed as the
// default and overridable via VITE_MS_CLIENT_ID. Redirect URIs registered: https://www.inkwave.studio
// + http://localhost:5173 (dev). Authority /common + delegated Files.ReadWrite.AppFolder.
const CLIENT_ID = (import.meta.env?.VITE_MS_CLIENT_ID as string | undefined) || 'be76cc89-ab01-4681-99c0-f37b9f9d2308'
// Personal + work/school accounts; AppFolder = a single dedicated OneDrive/Apps/Inkwave folder.
const AUTHORITY = 'https://login.microsoftonline.com/common'
const SCOPES = ['Files.ReadWrite.AppFolder', 'User.Read']
const GRAPH_APPROOT = 'https://graph.microsoft.com/v1.0/me/drive/special/approot:'

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
async function getSilentToken(): Promise<string | null> {
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

async function putFile(token: string, name: string, content: string): Promise<void> {
  const res = await fetch(`${GRAPH_APPROOT}/${encodeURIComponent(name)}:/content`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
    body: content,
  })
  if (!res.ok) throw new Error(`Graph upload failed (${res.status})`)
}

/**
 * Sync the record to OneDrive/Apps/Inkwave using the existing session (no UI). Returns false if not
 * signed in — call startOneDriveSignIn() first. Used for both the explicit sync and auto-sync.
 */
export async function syncToOneDrive(doc: InkwaveDocument, snapshots: Snapshot[]): Promise<boolean> {
  if (!CLIENT_ID) return false
  const token = await getSilentToken()
  if (!token) return false
  // One self-contained file: the bundle holds content + snapshots + Bitcoin proofs + receipts, with
  // the readable text header on top. (User-chosen folder selection — the OneDrive picker — is a
  // planned follow-up; for now it lands in the app's OneDrive folder.)
  const bundle = buildExportBundle(doc, snapshots)
  try {
    await putFile(token, bundleFilename(doc), JSON.stringify(bundle, null, 2))
    return true
  } catch {
    return false
  }
}
