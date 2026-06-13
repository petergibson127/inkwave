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
import { buildExportBundle, bundleFilename, bundleReadme } from '../provenance/bundle'

const CLIENT_ID = import.meta.env?.VITE_MS_CLIENT_ID as string | undefined
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
  loginPopup: (o: unknown) => Promise<{ accessToken: string }>
  logoutPopup: (o: unknown) => Promise<void>
}> {
  if (!CLIENT_ID) throw new Error('OneDrive not configured')
  if (!appPromise) {
    appPromise = import('@azure/msal-browser').then(async (m) => {
      const app = new m.PublicClientApplication({
        auth: { clientId: CLIENT_ID, authority: AUTHORITY, redirectUri: window.location.origin },
        cache: { cacheLocation: 'localStorage' },
      })
      await app.initialize()
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

// Get an access token: silent if a session exists; interactive (popup) only when allowed.
async function getToken(interactive: boolean): Promise<string | null> {
  const app = await getApp()
  const account = app.getAllAccounts()[0]
  if (account) {
    try {
      return (await app.acquireTokenSilent({ scopes: SCOPES, account })).accessToken
    } catch { /* expired / needs interaction */ }
  }
  if (!interactive) return null
  try {
    return (await app.loginPopup({ scopes: SCOPES })).accessToken
  } catch {
    return null // user cancelled / popup blocked
  }
}

/** Sign in (popup). Returns the account email, or null if cancelled. */
export async function signInOneDrive(): Promise<string | null> {
  if (!CLIENT_ID) return null
  const token = await getToken(true)
  if (!token) return null
  return oneDriveAccount()
}

export async function signOutOneDrive(): Promise<void> {
  if (!CLIENT_ID) return
  const app = await getApp()
  const account = app.getAllAccounts()[0]
  if (account) await app.logoutPopup({ account })
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
 * Sync the record to OneDrive/Apps/Inkwave. `interactive` allows a sign-in popup (use for the
 * explicit "sync" button); pass false for background auto-sync (silent token only — no popup).
 * Returns true on success.
 */
export async function syncToOneDrive(
  doc: InkwaveDocument,
  snapshots: Snapshot[],
  interactive = true,
): Promise<boolean> {
  if (!CLIENT_ID) return false
  const token = await getToken(interactive)
  if (!token) return false
  const bundle = buildExportBundle(doc, snapshots)
  try {
    await putFile(token, bundleFilename(doc), JSON.stringify(bundle, null, 2))
    await putFile(token, `${doc.id}.current.json`, JSON.stringify(doc, null, 2))
    await putFile(token, `${doc.id}.snapshots.json`, JSON.stringify(snapshots, null, 2))
    await putFile(token, 'README.txt', bundleReadme(bundle.summary))
    return true
  } catch {
    return false
  }
}
