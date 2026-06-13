import { useEffect, useState } from 'react'

// Best-effort browser-zoom compensation for the fixed chrome (toolbar, snapshots panel, sync
// status), so it stays ~100% while the writer zooms the PAGE (Ctrl +/−) to size the text.
//
// Browser zoom isn't exposed directly, but it scales window.devicePixelRatio relative to the
// load-time baseline in Chrome/Firefox/Edge. Safari doesn't change DPR on zoom, so it's a no-op
// there (acceptable — documented best-effort). Returns 1 when not zoomed, so callers apply NO
// transform in the common case (zero regression at 100%).
export function useZoomScale(): number {
  const [scale, setScale] = useState(1)

  useEffect(() => {
    if (typeof window === 'undefined') return
    const baseline = window.devicePixelRatio || 1
    const update = () => {
      const zoom = (window.devicePixelRatio || 1) / baseline
      // Counter the zoom (scale by 1/zoom), but ignore tiny deltas (jitter) and clamp so the chrome
      // never becomes unusably small or large.
      if (Math.abs(zoom - 1) < 0.03) { setScale(1); return }
      const s = Math.min(1.6, Math.max(0.6, 1 / zoom))
      setScale(Number(s.toFixed(3)))
    }
    update()
    window.addEventListener('resize', update) // DPR changes fire a resize event
    return () => window.removeEventListener('resize', update)
  }, [])

  return scale
}
