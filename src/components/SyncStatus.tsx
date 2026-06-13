import { useEffect, useState } from 'react'

// Bottom-right OneDrive sync indicator: "☁ synced to OneDrive · <path>", with the "X ago" revealed
// on hover. Re-renders on a timer so the relative time stays fresh. Hidden until connected.
function relativeTime(t: number): string {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s} seconds ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`
  const h = Math.round(m / 60)
  return `${h} hour${h === 1 ? '' : 's'} ago`
}

export function SyncStatus({ account, lastSync, path }: { account: string | null; lastSync: number | null; path?: string | null }) {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!account) return
    const id = setInterval(() => tick((n) => n + 1), 5000)
    return () => clearInterval(id)
  }, [account])

  if (!account) return null
  return (
    <div
      className="group fixed bottom-4 right-4 z-40 font-serif text-sm text-stone-500 select-none cursor-default"
      title={`OneDrive: ${account}`}
    >
      {lastSync ? (
        <>
          ☁ synced to OneDrive{path ? ` · ${path}` : ''}
          {/* "X seconds ago" only on hover */}
          <span className="text-stone-400 opacity-0 group-hover:opacity-100 transition-opacity"> · {relativeTime(lastSync)}</span>
        </>
      ) : (
        '☁ OneDrive connected'
      )}
    </div>
  )
}
