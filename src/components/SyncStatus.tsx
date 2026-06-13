import { useEffect, useRef, useState } from 'react'

// Bottom-right OneDrive indicator: a compact pill that, on hover/tap, opens a small panel ABOVE it
// (so it never grows leftward into the text). The panel shows the file path (in a fixed-width box
// that wraps), when it last synced, a "copy path" button, and "open in OneDrive". Hidden until
// connected; re-renders on a timer so the relative time stays fresh.
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
  account, lastSync, path, webUrl, onChangeFolder,
}: {
  account: string | null
  lastSync: number | null
  path?: string | null
  webUrl?: string | null
  onChangeFolder?: () => void
}) {
  const [, tick] = useState(0)
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!account) return
    const id = setInterval(() => tick((n) => n + 1), 5000)
    return () => clearInterval(id)
  }, [account])

  if (!account) return null

  function copyPath() {
    if (!path) return
    void navigator.clipboard?.writeText(path).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }).catch(() => {})
  }

  return (
    <div
      className="fixed bottom-4 right-4 z-40 font-serif select-none flex flex-col items-end"
      onMouseEnter={() => { if (closeTimer.current) clearTimeout(closeTimer.current); setOpen(true) }}
      onMouseLeave={() => { closeTimer.current = setTimeout(() => setOpen(false), 150) }}
    >
      {/* Detail panel — opens UPWARD, fixed width, path wraps inside it. */}
      {open && lastSync && (
        <div
          className="mb-2 w-64 bg-white shadow-lg rounded-xl p-3 text-stone-600"
          style={{ border: `1px solid ${INK}40` }}
        >
          <div className="text-xs text-stone-400 mb-1.5">synced {relativeTime(lastSync)}</div>
          {path && (
            <div className="text-xs text-stone-600 bg-stone-50 rounded-lg px-2 py-1.5 mb-2 break-words" style={{ wordBreak: 'break-word' }}>
              {path}
            </div>
          )}
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
            {path && (
              <button type="button" onClick={copyPath} className="underline hover:text-[#5c2d8a]" style={{ color: INK }}>
                {copied ? '✓ copied' : 'Copy path'}
              </button>
            )}
            {webUrl && (
              <a href={webUrl} target="_blank" rel="noreferrer" className="underline hover:text-[#5c2d8a]" style={{ color: INK }}>
                Open in OneDrive ↗
              </a>
            )}
            {onChangeFolder && (
              <button type="button" onClick={onChangeFolder} className="underline hover:text-[#5c2d8a]" style={{ color: INK }}>
                Change folder
              </button>
            )}
          </div>
        </div>
      )}

      {/* Compact pill (always right-anchored — never overlaps the centered text). */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={`OneDrive: ${account}`}
        className="text-sm text-stone-500 cursor-pointer rounded-full px-2.5 py-0.5 bg-white/70 hover:text-[#5c2d8a] hover:bg-white transition-colors"
      >
        {lastSync ? '☁ Synced to OneDrive' : '☁ OneDrive connected'}
      </button>
    </div>
  )
}
