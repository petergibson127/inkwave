import { useEffect, useState } from 'react'

// Best-effort: keep fixed chrome (toolbar, snapshots, sync status) ~constant size while the writer
// zooms the PAGE (Ctrl +/−) to size the text. Zoom isn't exposed directly; we infer it from
// devicePixelRatio relative to a baseline. The baseline is captured AFTER a short settle — mount-time
// DPR is unreliable on some browsers (Edge reported a transient value → chrome came out too small).
// Returns 1 until settled and whenever not meaningfully zoomed, so callers apply NO transform in the
// common 100% case (zero regression). Clamp covers the whole browser zoom range (25–500%).
export function useZoomScale(): number {
  const [scale, setScale] = useState(1)

  useEffect(() => {
    if (typeof window === 'undefined') return
    let baseline = 0 // 0 until settled → no compensation before then
    const compute = () => {
      if (!baseline) return
      const ratio = (window.devicePixelRatio || 1) / baseline
      if (Math.abs(ratio - 1) < 0.02) { setScale(1); return } // ~100%: no transform
      setScale(Number(Math.min(4, Math.max(0.2, 1 / ratio)).toFixed(4)))
    }
    const settle = setTimeout(() => { baseline = window.devicePixelRatio || 1; compute() }, 400)
    window.addEventListener('resize', compute) // DPR/zoom changes fire a resize
    return () => { clearTimeout(settle); window.removeEventListener('resize', compute) }
  }, [])

  return scale
}
