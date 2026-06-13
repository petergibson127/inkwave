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
      // Counter the zoom by scaling 1/zoom — EXACT compensation (page ×zoom, chrome ×1/zoom = 1).
      // Tiny deadzone so we apply NO transform at ~100% (the common case). Clamp covers the whole
      // browser zoom range (25%–500% ⇒ 1/zoom ∈ [0.2, 4]); the previous narrow clamp is what made
      // the chrome "whoosh" once you zoomed past it.
      if (Math.abs(zoom - 1) < 0.02) { setScale(1); return }
      const s = Math.min(4, Math.max(0.2, 1 / zoom))
      setScale(Number(s.toFixed(4)))
    }
    update()
    window.addEventListener('resize', update) // DPR changes fire a resize event
    return () => window.removeEventListener('resize', update)
  }, [])

  return scale
}
