// OptionsMenu — kebab button at the right of the footer toolbar.
//
// Opens the app menu: About + conventional New / Open / Open Recent / Save. Document switching
// (open/new) persists the active id and reloads — the editor's loader (Edit.tsx) then opens it.

import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router'
import { v4 as uuidv4 } from 'uuid'
import type { DocumentMeta, InkwaveDocument } from '../types/document'
import { listMeta, upsertMeta } from '../storage/indexeddb'
import { saveDocument, emptyTiptapDoc } from '../storage/opfs'
import { withScasDefaults } from '../scas/state'

const ACTIVE_DOC_KEY = 'inkwave:activeDocumentId'
const INK = '#5c2d8a'

type ModalKey = 'open' | 'recent' | 'save'
const MODAL_TITLES: Record<ModalKey, string> = { open: 'Open', recent: 'Open Recent', save: 'Save' }

// Switch the active document by id and reload so the editor loads it cleanly.
function openDocument(id: string) {
  try { localStorage.setItem(ACTIVE_DOC_KEY, id) } catch { /* private mode */ }
  window.location.reload()
}

async function createDocument(title: string, contentJson: InkwaveDocument['contentJson']): Promise<void> {
  const now = new Date().toISOString()
  const doc = withScasDefaults({
    id: uuidv4(), title, contentJson, createdAt: now, updatedAt: now,
    schemaVersion: '0.1.0', scasLimitN: 'infinite', scasSessionSeed: uuidv4(),
  })
  await saveDocument(doc)
  await upsertMeta({ id: doc.id, title: doc.title, updatedAt: doc.updatedAt })
  openDocument(doc.id)
}

export function OptionsMenu({
  paperRight,
  onExportBundle,
  onSave,
  folderAvailable,
  onSyncOneDrive,
  oneDriveAccount,
}: {
  paperRight: number
  onExportBundle?: () => void
  onSave?: () => void
  folderAvailable?: boolean
  onSyncOneDrive?: () => void
  oneDriveAccount?: string | null
}) {
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  const [modal, setModal] = useState<ModalKey | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setMenuOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [menuOpen])

  const items: Array<{ label: string; run: () => void }> = [
    { label: 'New', run: () => void createDocument('Untitled', emptyTiptapDoc()) },
    { label: 'Open…', run: () => setModal('open') },
    { label: 'Open Recent', run: () => setModal('recent') },
    { label: 'Save…', run: () => setModal('save') },
    { label: 'About', run: () => navigate('/about') },
  ]
  if (import.meta.env.DEV) {
    const on = typeof localStorage !== 'undefined' && localStorage.getItem('inkwave:debugHighlightAll') === '1'
    items.push({
      label: `Debug: highlight all ${on ? '✓' : '✗'}`,
      run: () => { try { localStorage.setItem('inkwave:debugHighlightAll', on ? '0' : '1') } catch { /* private */ } window.location.reload() },
    })
  }

  // Anchor the menu's right edge to the kebab (so it comes up overlapping the toolbar), extending
  // toward the page edge but never closer than EDGE_BUFFER — at which point it keeps that buffer.
  const EDGE_BUFFER = 10
  const menuStyle: CSSProperties = { border: `1px solid ${INK}66`, borderRadius: '10px' }
  if (menuOpen) {
    const br = btnRef.current?.getBoundingClientRect()
    menuStyle.position = 'fixed'
    menuStyle.bottom = br ? Math.round(window.innerHeight - br.top + 6) : 60
    menuStyle.right = br
      ? Math.max(EDGE_BUFFER, Math.round(window.innerWidth - br.right))
      : Math.max(EDGE_BUFFER, Math.round(window.innerWidth - paperRight + 12))
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={btnRef} type="button" aria-label="Options" aria-haspopup="menu" aria-expanded={menuOpen}
        onClick={() => setMenuOpen(o => !o)}
        className="flex items-center justify-center w-7 h-7 rounded-full text-stone-400 hover:text-[#5c2d8a] hover:bg-stone-100 transition-colors"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="12" cy="5" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="12" cy="19" r="1.7" />
        </svg>
      </button>

      {menuOpen && (
        <div role="menu" className="z-[60] w-44 py-1 bg-white shadow-md text-sm text-stone-600 font-serif" style={menuStyle}>
          {items.map(it => (
            <button key={it.label} role="menuitem" type="button"
              onClick={() => { setMenuOpen(false); it.run() }}
              className="w-full text-left px-4 py-1.5 hover:bg-stone-100 hover:text-[#5c2d8a] transition-colors"
            >
              {it.label}
            </button>
          ))}
        </div>
      )}

      {modal && (
        <Modal title={MODAL_TITLES[modal]} onClose={() => setModal(null)}>
          {modal === 'save' && <SavePanel onExportBundle={onExportBundle} onSave={onSave} folderAvailable={folderAvailable} onSyncOneDrive={onSyncOneDrive} oneDriveAccount={oneDriveAccount} onDone={() => setModal(null)} />}
          {modal === 'open' && <OpenPanel onClose={() => setModal(null)} />}
          {modal === 'recent' && <RecentPanel />}
        </Modal>
      )}
    </div>
  )
}

// ─── Panels ───────────────────────────────────────────────────────────────────

function MenuButton({ onClick, children }: { onClick?: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} disabled={!onClick}
      className="w-full text-left px-4 py-2.5 font-serif transition-colors disabled:opacity-40"
      style={{ border: `1px solid ${INK}55`, borderRadius: 10, color: INK }}
      onMouseOver={e => { if (onClick) e.currentTarget.style.background = '#faf7fd' }}
      onMouseOut={e => { e.currentTarget.style.background = 'transparent' }}
    >
      {children}
    </button>
  )
}

function SavePanel({ onExportBundle, onSave, folderAvailable, onSyncOneDrive, oneDriveAccount, onDone }: {
  onExportBundle?: () => void; onSave?: () => void; folderAvailable?: boolean
  onSyncOneDrive?: () => void; oneDriveAccount?: string | null; onDone: () => void
}) {
  return (
    <div className="flex flex-col gap-2.5 mt-2">
      <MenuButton onClick={onSave ? () => { onSave(); onDone() } : undefined}>
        🗀 Sync to folder
        <span className="block text-xs text-stone-400">
          {folderAvailable
            ? 'mirror your work into a folder you control (auto-syncs if it’s a cloud folder)'
            : 'downloads your self-verifying record (live folder sync needs Chrome, Edge or Brave)'}
        </span>
      </MenuButton>
      {onSyncOneDrive && (
        <MenuButton onClick={() => { onSyncOneDrive(); onDone() }}>
          {oneDriveAccount ? '☁ Re-sync to OneDrive' : '☁ Sync to OneDrive'}
          <span className="block text-xs text-stone-400">
            {oneDriveAccount ? `signed in as ${oneDriveAccount} · syncs as you write` : 'sign in with Microsoft — works on any browser, incl. Firefox & Safari'}
          </span>
        </MenuButton>
      )}
      <MenuButton onClick={onExportBundle ? () => { onExportBundle(); onDone() } : undefined}>
        ⤓ Download a copy<span className="block text-xs text-stone-400">a self-verifying file you can keep or check at /verify</span>
      </MenuButton>
    </div>
  )
}

function OpenPanel({ onClose }: { onClose: () => void }) {
  const [error, setError] = useState<string | null>(null)
  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const data = JSON.parse(await file.text())
      // Accept a raw document OR an export bundle (which nests the document).
      const contentJson = data.contentJson ?? data.document?.contentJson
      const title = data.title ?? data.document?.title ?? file.name.replace(/\.json$/, '')
      if (!contentJson) throw new Error('not an Inkwave document or export bundle')
      await createDocument(title, contentJson)
      onClose()
    } catch (err) {
      setError((err as Error).message)
    }
  }
  return (
    <div className="mt-2">
      <label className="block border-2 border-dashed rounded-xl px-4 py-7 text-center cursor-pointer hover:bg-stone-50" style={{ borderColor: `${INK}55`, color: INK }}>
        <input type="file" accept="application/json,.json" className="hidden" onChange={onFile} />
        Choose a file…
        <span className="block text-xs text-stone-400 mt-1">an Inkwave document or export bundle (.json)</span>
      </label>
      {error && <p className="text-xs text-red-700 mt-2">⚠ {error}</p>}
    </div>
  )
}

function RecentPanel() {
  const [recents, setRecents] = useState<DocumentMeta[] | null>(null)
  useEffect(() => { void listMeta().then(setRecents) }, [])
  return (
    <div className="mt-2 flex flex-col gap-1.5 max-h-72 overflow-auto">
      <MenuButton onClick={() => void createDocument('Untitled', emptyTiptapDoc())}>+ New document</MenuButton>
      {recents === null && <p className="text-sm text-stone-400 px-1">Loading…</p>}
      {recents?.length === 0 && <p className="text-sm text-stone-400 px-1">No documents yet.</p>}
      {recents?.map(m => (
        <button key={m.id} type="button" onClick={() => openDocument(m.id)}
          className="w-full text-left px-4 py-2 font-serif hover:bg-stone-50 transition-colors"
          style={{ border: '1px solid #eee', borderRadius: 8 }}
        >
          <span style={{ color: INK }}>{m.title || 'Untitled'}</span>
          <span className="block text-xs text-stone-400">{new Date(m.updatedAt).toLocaleString()}</span>
        </button>
      ))}
    </div>
  )
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Portal to body so the backdrop reliably covers the viewport and catches outside clicks (not
  // trapped in the footer's pointer-events/stacking context).
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" onMouseDown={onClose}>
      <div className="absolute inset-0 bg-stone-900/20" aria-hidden="true" />
      <div role="dialog" aria-modal="true" aria-label={title} onMouseDown={e => e.stopPropagation()}
        className="relative bg-white w-full max-w-md p-6 flex flex-col shadow-xl"
        style={{ border: `1px solid ${INK}bf`, borderRadius: '14px' }}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-serif" style={{ color: INK }}>{title}</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="text-stone-400 hover:text-[#5c2d8a] text-2xl leading-none">×</button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  )
}
