import { useEffect, useRef, useState } from 'react'
import { useZoomScale } from '../editor/useZoomScale'

// Bottom-right sync indicator: a compact pill that, on hover/tap, opens a small panel ABOVE it (so
// it never grows leftward into the text). The pill text is decided by the caller so it reads clearly
// in every state — "Synced to folder", "OneDrive — not yet syncing", "OneDrive disconnected". When
// not synced the pill is actionable (onClick connects / retries). Works for a local folder (Chromium)
// or OneDrive (Firefox/Safari). Re-renders on a timer so the relative time stays fresh.
const INK = '#5c2d8a'

function relativeTime(t: number): string {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s} seconds ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`
  const h = Math.round(m / 60)
  return `${h} hour${h === 1 ? '' : 's'} ago`
}

export function SyncStatus({
  label, synced, path, lastSync, tooltip, webUrl, onShowInFolder, onChangeFolder, onClick,
}: {
  label: string
  synced: boolean
  path?: string | null
  lastSync?: number | null
  tooltip?: string
  webUrl?: string | null // when present, "Open in folder" opens it (the file in OneDrive)
  onShowInFolder?: () => void // local folder: reveal the file's folder (native picker startIn)
  onChangeFolder?: () => void
  onClick?: () => void // pill action when not synced (connect / sync now)
}) {
  const [, tick] = useState(0)
  const [open, setOpen] = useState(false)
  const zoom = useZoomScale()
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 5000)
    return () => clearInterval(id)
  }, [])

  return (
    <div
      className="fixed bottom-0 right-0 z-40 font-serif select-none flex flex-col items-end"
      style={{ padding: '1rem', transform: zoom !== 1 ? `scale(${zoom})` : undefined, transformOrigin: 'bottom right' }}
      onMouseEnter={() => { if (closeTimer.current) clearTimeout(closeTimer.current); setOpen(true) }}
      onMouseLeave={() => { closeTimer.current = setTimeout(() => setOpen(false), 150) }}
    >
      {/* Detail panel — opens UPWARD, fixed width, path wraps inside it. */}
      {open && (
        <div className="mb-2 w-64 bg-white shadow-lg rounded-xl p-3 text-stone-600" style={{ border: `1px solid ${INK}40` }}>
          <div className="text-xs text-stone-400 mb-1.5">
            {synced && lastSync ? `synced ${relativeTime(lastSync)}` : 'not syncing yet — your work is still saved on this device'}
          </div>
          {path && (
            <div className="text-xs text-stone-600 bg-stone-50 rounded-lg px-2 py-1.5 mb-2 break-words" style={{ wordBreak: 'break-word' }}>
              {path}
            </div>
          )}
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {webUrl && (
              <a href={webUrl} target="_blank" rel="noreferrer" className="underline hover:text-[#5c2d8a]" style={{ color: INK }}>
                Open in folder ↗
              </a>
            )}
            {onShowInFolder && (
              <button type="button" onClick={onShowInFolder} className="underline hover:text-[#5c2d8a]" style={{ color: INK }}>
                Show in folder
              </button>
            )}
            {onChangeFolder && (
              <button type="button" onClick={onChangeFolder} className="underline hover:text-[#5c2d8a]" style={{ color: INK }}>
                Change folder
              </button>
            )}
            {!synced && onClick && (
              <button type="button" onClick={onClick} className="underline hover:text-[#5c2d8a]" style={{ color: INK }}>
                Sync now
              </button>
            )}
          </div>
        </div>
      )}

      {/* Compact pill — right-anchored (never overlaps the centered text). */}
      <button
        type="button"
        onClick={() => (onClick && !synced ? onClick() : setOpen((o) => !o))}
        title={tooltip}
        className="text-sm cursor-pointer rounded-full px-2.5 py-0.5 bg-white/70 hover:bg-white transition-colors"
        style={{ color: synced ? '#6b7280' : '#b45309' }}
      >
        {label}
      </button>
    </div>
  )
}
