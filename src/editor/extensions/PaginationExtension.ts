// Gapped pages (opt-in). A ProseMirror plugin that measures the document and inserts a full-bleed
// "page gap" widget at each A4 boundary — content reflows onto separate sheets (breaks only at
// top-level block boundaries, so a line is never cut), with a centred page number in each gap.
//
// Measurement is loop-free: block positions are read as INTRINSIC (the gap-widget heights are
// subtracted back out), so adding gaps never changes the measured layout. A signature guard stops
// the recompute→dispatch→recompute cycle once nothing changes.

import { Extension } from '@tiptap/react'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view'

const KEY = new PluginKey<DecorationSet>('pagination')
const GAP = 56 // px of aqua (waves) between sheets
const MARGIN_TOP = 72 // px parchment margin at the top of every page (incl. page 1)
const MARGIN_BOTTOM = 72 // px parchment margin at the bottom of every page (page numbers sit here)

export interface PaginationOptions { enabled: boolean }

// The gap widget reserves the vertical space between the last line of one page and the first line of
// the next: [ bottom margin of page above | GAP (transparent) | top margin of page below ]. It hosts
// an (empty) band marker at the gap offset so the paint() pass can measure exactly where the
// transparent gap is and lay the parchment sheet panels around it. No visible parts of its own —
// the panels paint the parchment, the page number is a footer inside each panel.
function gapEl(botMargin: number, topMargin: number): HTMLElement {
  // SPAN, not div: a page break can land mid-paragraph, and a block-level <div> is invalid as a
  // child of <p> — the browser then reparents/splits the paragraph in the rendered DOM, scrambling
  // caret placement (the caret jumps across the gap, edits land on the wrong page). A <span> is valid
  // phrasing content inside <p>; CSS gives it `display:block` so it still reserves the vertical gap.
  const el = document.createElement('span')
  el.className = 'inkwave-page-gap'
  el.style.height = `${Math.round(botMargin + GAP + topMargin)}px`
  el.contentEditable = 'false'
  const band = document.createElement('span')
  band.className = 'inkwave-page-gap-band'
  band.style.top = `${Math.round(botMargin)}px`
  band.style.height = `${GAP}px`
  el.appendChild(band)
  return el
}

// Collect every LINE as { intrinsic top, doc position of its start } — so a page break can land
// mid-paragraph (a gap widget at a line-start splits the paragraph in two). "Intrinsic" = the layout
// AS IF no gap widgets existed: each line's top has the total height of all gap widgets ABOVE it (by
// screen Y) subtracted. Subtracting by Y — not by walking top-level children — is what makes this
// correct even when a gap renders NESTED inside a paragraph (a mid-paragraph break); otherwise that
// gap's height is missed and the measured page heights drift/oscillate. Intrinsic tops are invariant
// to the gaps, so the pagination is a stable fixpoint.
function collectLines(view: EditorView, editorTop: number): Array<{ top: number; pos: number }> {
  const dom = view.dom as HTMLElement
  const gaps = Array.from(dom.querySelectorAll('.inkwave-page-gap')).map((g) => {
    const r = g.getBoundingClientRect(); return { top: r.top, h: r.height }
  })
  const accumAbove = (top: number): number => {
    let s = 0; for (const g of gaps) if (g.top <= top - 2) s += g.h; return s
  }
  const lines: Array<{ top: number; pos: number }> = []
  for (const child of Array.from(dom.children) as HTMLElement[]) {
    if (child.classList?.contains('inkwave-page-gap')) continue // the widget itself isn't a line
    let rects: DOMRect[] = []
    try { const range = document.createRange(); range.selectNodeContents(child); rects = Array.from(range.getClientRects()) } catch { /* ignore */ }
    if (!rects.length) { // empty block (e.g. a blank paragraph) → one line at the block top
      const r = child.getBoundingClientRect()
      const at = view.posAtCoords({ left: r.left + 1, top: r.top + Math.min(8, r.height / 2) })?.pos
      lines.push({ top: r.top - editorTop - accumAbove(r.top), pos: at != null && at > 0 ? at : 0 })
      continue
    }
    let lastTop = -1e9
    for (const r of rects) {
      // dedup inline rects on the same line; skip tall boxes (a nested gap widget, not a text line)
      if (r.width < 1 || r.height < 1 || r.height > 80 || r.top - lastTop <= 3) continue
      lastTop = r.top
      const at = view.posAtCoords({ left: r.left + 1, top: r.top + r.height / 2 })?.pos
      lines.push({ top: r.top - editorTop - accumAbove(r.top), pos: at != null && at > 0 ? at : 0 })
    }
  }
  lines.sort((a, b) => a.top - b.top)
  return lines
}

function compute(view: EditorView, pageH: number): { set: DecorationSet; sig: string } {
  if (pageH <= 0) return { set: DecorationSet.empty, sig: 'empty' }
  const editorTop = (view.dom as HTMLElement).getBoundingClientRect().top
  const doc = view.state.doc

  const lines = collectLines(view, editorTop)
  if (!lines.length) return { set: DecorationSet.empty, sig: 'empty' }

  // Each page's TEXT area is the A4 height minus the top + bottom margins; we break before the line
  // that would overflow it, so text never reaches the bottom edge / the gap.
  const textArea = Math.max(1, pageH - MARGIN_TOP - MARGIN_BOTTOM)
  const decos: Decoration[] = []
  const sig: string[] = []
  let used = 0
  let pageNo = 1
  for (let i = 0; i < lines.length; i++) {
    const lh = i < lines.length - 1 ? Math.max(1, lines[i + 1].top - lines[i].top) : 24
    // Break before the LINE that would overflow the text area — splitting the paragraph if mid-block.
    if (i > 0 && used + lh > textArea && lines[i].pos > 0) {
      // Parchment left below the last line on this page (its bottom margin), at least MARGIN_BOTTOM.
      const botMargin = Math.max(MARGIN_BOTTOM, pageH - MARGIN_TOP - used)
      const at = lines[i].pos
      // ignoreSelection: the gap is a TALL block widget sitting mid-paragraph; without this,
      // ProseMirror folds its height into cursor/selection coordinate mapping, so a click at the end
      // of the page-above jumps the caret past the gap to the start of the next page (and edits then
      // land on the wrong page, which read as "deletions don't reflow"). Ignoring it for selection
      // keeps the caret on the text it belongs to. stopEvent: clicks on the gap aren't editor input.
      // side:1 — the cursor AT the break position (after the page-above's last word + its trailing
      // space) renders BEFORE the gap (end of the page above), not after it (start of the next page).
      decos.push(Decoration.widget(at, () => gapEl(botMargin, MARGIN_TOP), { side: 1, ignoreSelection: true, stopEvent: () => true, key: `gap-${pageNo}-${at}` }))
      sig.push(`${at}:${Math.round(botMargin)}`)
      pageNo++
      used = 0
    }
    used += lh
  }
  sig.push(`pages:${pageNo}`)
  return { set: DecorationSet.create(doc, decos), sig: sig.join('|') }
}

export const PaginationExtension = Extension.create<PaginationOptions>({
  name: 'pagination',
  addOptions() { return { enabled: false } },
  addProseMirrorPlugins() {
    const enabled = this.options.enabled
    return [
      new Plugin<DecorationSet>({
        key: KEY,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, old) {
            const meta = tr.getMeta(KEY) as DecorationSet | undefined
            return meta ?? old.map(tr.mapping, tr.doc)
          },
        },
        props: { decorations(state) { return KEY.getState(state) } },
        view(view) {
          if (!enabled) return {}
          let raf = 0
          let paintRaf = 0
          let lastInputSig = '' // doc size + page height — only re-measure when these change
          let sheet: HTMLElement | null = null
          let layer: HTMLElement | null = null
          let observed = false
          const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => schedule()) : null

          // A background layer of REAL parchment sheet panels, one per page, positioned at the
          // measured page regions (between the gap bands). Each is its own <div>, so it gets a real
          // 4-side drop shadow + rounded corners — discrete sheets like Word — and the gaps between
          // them are genuinely transparent, so the fixed background + waves show through and match
          // the surroundings exactly. Lives behind the text (z-index 0); text container is z-index 1.
          // Resolved LAZILY: at plugin-view construction the editor isn't inside .scroll-paper yet.
          const ensureSheet = () => {
            if (!sheet) sheet = (view.dom as HTMLElement).closest('.scroll-paper') as HTMLElement | null
            if (sheet && !layer) {
              layer = document.createElement('div')
              layer.className = 'inkwave-sheets'
              layer.setAttribute('aria-hidden', 'true')
              sheet.insertBefore(layer, sheet.firstChild)
            }
            if (sheet && ro && !observed) { ro.observe(sheet); observed = true }
            return sheet
          }
          // Position panels at every region NOT covered by a gap band: [0..band0], [band0..band1], …
          const paint = () => {
            paintRaf = 0
            if (!sheet || !layer) return
            const sheetTop = sheet.getBoundingClientRect().top
            const total = sheet.scrollHeight
            const bands = Array.from(sheet.querySelectorAll('.inkwave-page-gap-band')) as HTMLElement[]
            const segs: Array<{ top: number; height: number }> = []
            let cursor = 0
            for (const band of bands) {
              const r = band.getBoundingClientRect()
              const top = Math.round(r.top - sheetTop)
              const bottom = Math.round(r.top - sheetTop + r.height)
              if (top <= cursor) { cursor = Math.max(cursor, bottom); continue }
              segs.push({ top: cursor, height: top - cursor })
              cursor = bottom
            }
            segs.push({ top: cursor, height: Math.max(0, total - cursor) })
            // Reconcile the panel divs to match the segment list (reuse to avoid churn). Each panel
            // carries its page number as a footer pinned to its bottom margin (not in the gap).
            while (layer.children.length > segs.length) layer.lastElementChild!.remove()
            while (layer.children.length < segs.length) {
              const d = document.createElement('div')
              d.className = 'inkwave-sheet'
              const f = document.createElement('div')
              f.className = 'inkwave-sheet-num'
              d.appendChild(f)
              layer.appendChild(d)
            }
            segs.forEach((s, i) => {
              const d = layer!.children[i] as HTMLElement
              d.style.top = `${s.top}px`
              d.style.height = `${s.height}px`
              ;(d.firstChild as HTMLElement).textContent = String(i + 1)
            })
          }
          const schedulePaint = () => { if (!paintRaf) paintRaf = requestAnimationFrame(paint) }

          const recompute = () => {
            raf = 0
            ensureSheet()
            const pageH = (sheet ? sheet.clientWidth : 794) * Math.SQRT2
            if (sheet) {
              sheet.classList.add('inkwave-gapped')
              sheet.style.paddingTop = `${MARGIN_TOP}px` // page-1 top margin matches the rest
            }
            // Only re-measure when something that affects layout changed (text edit → doc size; zoom/
            // resize → pageH). Our own setMeta dispatches below don't change these, so they can't loop.
            const inputSig = `${view.state.doc.content.size}:${Math.round(pageH)}`
            if (inputSig === lastInputSig) { schedulePaint(); return }
            lastInputSig = inputSig

            // The gap widgets are display:block, so they FORCE line breaks — which means a word can't
            // wrap back across a page boundary, and measuring the line layout with them present shows
            // the forced break, not the natural wrap (so deletions never reflowed back). Fix: clear
            // the gaps first so the DOM reflows to its NATURAL wrapping, measure THAT, then re-add the
            // gaps. All synchronous within this one rAF tick, so the cleared state never paints (no
            // flicker) — getClientRects forces layout, not paint.
            const cur = KEY.getState(view.state)
            if (cur && cur !== DecorationSet.empty) {
              view.dispatch(view.state.tr.setMeta(KEY, DecorationSet.empty).setMeta('addToHistory', false))
            }
            const { set } = compute(view, pageH)
            view.dispatch(view.state.tr.setMeta(KEY, set).setMeta('addToHistory', false))
            // Re-measure & reposition the sheet panels after the decorations land (DOM settled).
            schedulePaint()
          }
          const schedule = () => { if (!raf) raf = requestAnimationFrame(recompute) }
          schedule()
          return {
            update: schedule,
            destroy() {
              ro?.disconnect()
              if (raf) cancelAnimationFrame(raf)
              if (paintRaf) cancelAnimationFrame(paintRaf)
              layer?.remove()
              sheet?.classList.remove('inkwave-gapped')
              if (sheet) sheet.style.paddingTop = ''
            },
          }
        },
      }),
    ]
  },
})
