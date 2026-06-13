import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'

// True on touch phones/tablets (coarse pointer, no hover). Device-based — does NOT change with
// browser zoom — so it's the right signal for "phone vs desktop" layout (margins, background).
export function isTouchDevice(): boolean {
  return typeof window !== 'undefined'
    && window.matchMedia?.('(pointer: coarse) and (hover: none)')?.matches === true
}

// The scroll "paper" chrome — the white page surface and the parchment column with its drop
// shadow. Shared by BOTH the live editor (TiptapEditor) and the prerendered/loading shell
// (EditorShell) so the static landing page is a direct visual function of the same components
// + CSS. Style changes here flow to both.
//
// Both wooden rollers are now removed and the page is pulled up near the top of the viewport
// (see the `.inkwave-editor-surface` rule in styles/index.css). Long-term the parchment grows a
// vectorised torn-paper edge; keeping the chrome in one shared component makes that a one-place change.
export function Scroll({
  children,
  paperRef,
  containerRef,
  phone = false,
}: {
  children: ReactNode
  paperRef?: RefObject<HTMLDivElement>
  containerRef?: RefObject<HTMLDivElement>
  phone?: boolean // touch device: paper fills the screen, no background (see isTouchDevice())
}) {
  // Fade the background waves out while the page is scrolled FAST (the tiled pattern shimmers
  // otherwise) and back in when it slows. Toggles `.waves-fast` based on scroll velocity.
  const surfaceRef = useRef<HTMLDivElement>(null)
  const sheetRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let lastY = window.scrollY
    let lastT = performance.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    const onScroll = () => {
      const y = window.scrollY
      const t = performance.now()
      const v = Math.abs(y - lastY) / Math.max(1, t - lastT) // px per ms
      lastY = y
      lastT = t
      const el = surfaceRef.current
      if (!el) return
      if (v > 0.9) {
        el.classList.add('waves-fast')
        clearTimeout(timer)
        timer = setTimeout(() => el.classList.remove('waves-fast'), 180) // fade back in once it slows
      }
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => { window.removeEventListener('scroll', onScroll); clearTimeout(timer) }
  }, [])

  return (
    <div ref={surfaceRef} className={`inkwave-editor-surface${phone ? ' is-phone' : ''}`}>
      {/* Parchment column. Desktop: a floating page (max-width + shadow + background gap). Phone:
          fills the screen edge-to-edge, no shadow. */}
      <div
        ref={paperRef}
        className={`mx-auto w-full ${phone ? 'max-w-full' : 'max-w-[780px]'}`}
        style={{
          // box-shadow (not filter: drop-shadow) so the absolutely-positioned cycle card
          // rendered inside doesn't feed its pixels into the shadow — drop-shadow re-rasterises
          // the whole parchment on every reel frame.
          borderRadius: phone ? 0 : '8px',
          boxShadow: phone ? 'none' : '0 8px 32px rgba(80,50,10,0.22), 0 2px 6px rgba(80,50,10,0.18)',
        }}
      >
        {/* Paper body. The side padding is the text margin: a roomy fixed margin on DESKTOP (driven
            by device type, not the viewport breakpoint, so browser zoom never collapses it); a slim
            one on phones where screen real estate is tight. */}
        <div ref={sheetRef} className={`scroll-paper relative pt-8 pb-24 ${phone ? 'px-4' : 'px-16'}`} style={{ borderRadius: phone ? 0 : '8px' }}>
          <PageGuides sheetRef={sheetRef} />
          <div className={`mx-auto w-full relative ${phone ? 'max-w-full' : 'max-w-[720px]'}`} style={{ zIndex: 1 }} ref={containerRef}>
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}

// Page guides: a faint divider + centred page number at each A4-proportioned interval down the
// sheet. The page height is the sheet WIDTH × √2 (A4's 1:√2 ratio), measured in the same units the
// text uses — so zooming reflows naturally (pages grow/shrink, the SAME words stay on each page).
// Recomputed on any size change (typing, resize, zoom). Purely visual overlay (no content reflow).
function PageGuides({ sheetRef }: { sheetRef: RefObject<HTMLDivElement> }) {
  const [marks, setMarks] = useState<Array<{ y: number; n: number; rule: boolean }>>([])
  useEffect(() => {
    const el = sheetRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const recompute = () => {
      const w = el.clientWidth
      const total = el.scrollHeight
      if (!w || !total) return setMarks([])
      const pageH = w * Math.SQRT2 // A4 portrait: height = width × √2
      const count = Math.max(1, Math.ceil(total / pageH))
      const next: Array<{ y: number; n: number; rule: boolean }> = []
      for (let i = 1; i <= count; i++) {
        const bottom = i * pageH
        next.push({ y: Math.min(bottom, total - 2), n: i, rule: bottom < total }) // rule only at real breaks
      }
      setMarks(next)
    }
    const ro = new ResizeObserver(recompute)
    ro.observe(el)
    recompute()
    return () => ro.disconnect()
  }, [sheetRef])

  return (
    <div className="absolute inset-0 pointer-events-none select-none" style={{ zIndex: 0 }} aria-hidden="true">
      {marks.map(({ y, n, rule }) => (
        <div key={n} style={{ position: 'absolute', top: y, left: 0, right: 0 }}>
          {rule && <div style={{ borderTop: '1px dashed rgba(92,45,138,0.16)' }} />}
          <div className="text-center font-serif" style={{ fontSize: '0.8rem', color: 'rgba(92,45,138,0.4)', marginTop: rule ? 4 : -18 }}>
            {n}
          </div>
        </div>
      ))}
    </div>
  )
}

// A static facsimile of the EMPTY ProseMirror surface — same classes as the live editor, so it
// paints identically. Used in the prerendered shell and while the document loads; the real
// editor mounts in its place client-side with no visual jump.
export function EmptyEditorSurface() {
  return (
    <div className="tiptap-editor ProseMirror" aria-hidden="true">
      <p>
        <br />
      </p>
    </div>
  )
}
