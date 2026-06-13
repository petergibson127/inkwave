import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { listFolders, listQuickFolders, type DriveFolder, type OneDriveFolder } from '../storage/onedrive'

// A small folder browser for OneDrive: drill into folders from the root, then "Sync here" to choose
// the destination for the .trace.json. Reads folders live via Microsoft Graph (the writer must be
// signed in). Returns { id, path } — id '' means the OneDrive root.
const INK = '#5c2d8a'

type Crumb = { id: string; name: string }

export function OneDriveFolderPicker({ onPick, onClose }: { onPick: (folder: OneDriveFolder) => void; onClose: () => void }) {
  const [crumbs, setCrumbs] = useState<Crumb[]>([]) // [] = root
  const [folders, setFolders] = useState<DriveFolder[] | null>(null)
  const [quick, setQuick] = useState<DriveFolder[]>([])
  const [error, setError] = useState<string | null>(null)

  const currentId = crumbs.length ? crumbs[crumbs.length - 1].id : null
  const currentPath = crumbs.map((c) => c.name).join('/')

  // Quick-access folders (Documents, Photos, …) — fetched once, shown at the root.
  useEffect(() => { void listQuickFolders().then(setQuick).catch(() => {}) }, [])

  useEffect(() => {
    let cancelled = false
    setFolders(null); setError(null)
    listFolders(currentId)
      .then((f) => { if (!cancelled) setFolders(f) })
      .catch((e) => { if (!cancelled) setError((e as Error).message) })
    return () => { cancelled = true }
  }, [currentId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" onMouseDown={onClose}>
      <div className="absolute inset-0 bg-stone-900/20" aria-hidden="true" />
      <div role="dialog" aria-modal="true" aria-label="Choose OneDrive folder" onMouseDown={(e) => e.stopPropagation()}
        className="relative bg-white w-full max-w-md p-6 flex flex-col shadow-xl" style={{ border: `1px solid ${INK}bf`, borderRadius: 14 }}>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-serif" style={{ color: INK }}>Choose OneDrive folder</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="text-stone-400 hover:text-[#5c2d8a] text-2xl leading-none">×</button>
        </div>

        {/* Breadcrumb */}
        <div className="text-xs text-stone-500 mb-2 flex flex-wrap items-center gap-1 font-serif">
          <button type="button" className="hover:underline" style={{ color: INK }} onClick={() => setCrumbs([])}>OneDrive</button>
          {crumbs.map((c, i) => (
            <span key={c.id} className="flex items-center gap-1">
              <span className="text-stone-300">/</span>
              <button type="button" className="hover:underline" style={{ color: INK }} onClick={() => setCrumbs(crumbs.slice(0, i + 1))}>{c.name}</button>
            </span>
          ))}
        </div>

        {/* Quick access — only at the root, to jump straight to common folders. */}
        {crumbs.length === 0 && quick.length > 0 && (
          <div className="mb-2">
            <div className="text-[11px] uppercase tracking-wide text-stone-400 mb-1">Quick access</div>
            <div className="flex flex-wrap gap-1.5">
              {quick.map((f) => (
                <button key={f.id} type="button" onClick={() => setCrumbs([{ id: f.id, name: f.name }])}
                  className="text-xs px-2.5 py-1 rounded-full font-serif hover:bg-stone-50" style={{ border: `1px solid ${INK}40`, color: INK }}>
                  🗁 {f.name}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="border rounded-lg max-h-64 overflow-auto" style={{ borderColor: '#eee' }}>
          {error && <p className="text-xs text-red-700 p-3">⚠ {error}</p>}
          {!error && folders === null && <p className="text-sm text-stone-400 p-3">Loading…</p>}
          {!error && folders?.length === 0 && <p className="text-sm text-stone-400 p-3">No sub-folders here.</p>}
          {folders?.map((f) => (
            <button key={f.id} type="button" onClick={() => setCrumbs([...crumbs, { id: f.id, name: f.name }])}
              className="w-full text-left px-3 py-2 text-sm font-serif hover:bg-stone-50 border-b last:border-b-0 flex items-center gap-2"
              style={{ borderColor: '#f0f0f0', color: '#444' }}>
              <span aria-hidden="true">🗁</span>{f.name}
            </button>
          ))}
        </div>

        <button type="button" onClick={() => onPick({ id: currentId ?? '', path: currentPath })}
          className="mt-4 px-4 py-2.5 font-serif text-white" style={{ background: INK, borderRadius: 10 }}>
          Sync here{currentPath ? ` — ${currentPath}` : ' — OneDrive (root)'}
        </button>
      </div>
    </div>,
    document.body,
  )
}
