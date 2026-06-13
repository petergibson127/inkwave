import type { ReactNode, RefObject } from 'react'

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
}: {
  children: ReactNode
  paperRef?: RefObject<HTMLDivElement>
  containerRef?: RefObject<HTMLDivElement>
}) {
  return (
    <div className="inkwave-editor-surface">
      {/* Parchment column — slightly wider than the text measure */}
      <div
        ref={paperRef}
        className="mx-auto w-full max-w-[600px] md:max-w-[780px]"
        style={{
          // box-shadow (not filter: drop-shadow) so the absolutely-positioned cycle card
          // rendered inside doesn't feed its pixels into the shadow — drop-shadow re-rasterises
          // the whole parchment on every reel frame.
          borderRadius: '8px',
          boxShadow: '0 8px 32px rgba(80,50,10,0.22), 0 2px 6px rgba(80,50,10,0.18)',
        }}
      >
        {/* Parchment paper body — a clean rounded rectangle now (both wooden rollers removed).
            This is the surface the vectorised torn-paper edge will eventually replace. */}
        {/* px-2 on mobile; thicker side margins on desktop (md:px-16) for roomier margins */}
        <div className="scroll-paper relative px-2 md:px-16 pt-8 pb-24" style={{ borderRadius: '8px' }}>
          <div className="mx-auto w-full max-w-[560px] md:max-w-[720px] relative" ref={containerRef}>
            {children}
          </div>
        </div>
      </div>
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
