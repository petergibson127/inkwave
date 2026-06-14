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
const GAP = 56 // px of aqua between sheets

export interface PaginationOptions { enabled: boolean }

// The widget is `total` tall: its TOP part (transparent) is the page-above's bottom margin — the
// continuous parchment shows through, so the page fills to A4 — and a BOTTOM band of `GAP` px shows
// the aqua/waves background with rounded, shadowed sheet edges + the centred page number.
function gapEl(totalPx: number, pageNum: number): HTMLElement {
  const el = document.createElement('div')
  el.className = 'inkwave-page-gap'
  el.style.height = `${Math.round(totalPx)}px`
  el.contentEditable = 'false'
  const band = document.createElement('div')
  band.className = 'inkwave-page-gap-band'
  band.style.height = `${GAP}px`
  const span = document.createElement('span')
  span.textContent = String(pageNum)
  band.appendChild(span)
  el.appendChild(band)
  return el
}

function numEl(pageNum: number): HTMLElement {
  const el = document.createElement('div')
  el.className = 'inkwave-page-num'
  el.contentEditable = 'false'
  el.textContent = String(pageNum)
  return el
}

// Collect every LINE in the document as { intrinsic top, doc position of its start } — so a page
// break can land mid-paragraph (the gap widget at a line-start splits the paragraph in two). Tops
// are intrinsic (our own gap-widget heights subtracted) so adding gaps doesn't move the measurement.
function collectLines(view: EditorView, editorTop: number, childPos: number[]): Array<{ top: number; pos: number }> {
  const dom = view.dom as HTMLElement
  const lines: Array<{ top: number; pos: number }> = []
  let accum = 0
  let childIdx = 0
  for (const child of Array.from(dom.children) as HTMLElement[]) {
    if (child.classList.contains('inkwave-page-gap')) { accum += child.getBoundingClientRect().height; continue }
    const startPos = childPos[childIdx] ?? 0
    childIdx++
    let rects: DOMRect[] = []
    try { const range = document.createRange(); range.selectNodeContents(child); rects = Array.from(range.getClientRects()) } catch { /* ignore */ }
    if (!rects.length) { // empty block (e.g. a blank paragraph) → one line at the block top
      lines.push({ top: child.getBoundingClientRect().top - editorTop - accum, pos: startPos })
      continue
    }
    let lastTop = -1e9
    for (const r of rects) {
      if (r.width < 1 || r.height < 1 || r.top - lastTop <= 3) continue // dedup inline-span rects on the same line
      lastTop = r.top
      const at = view.posAtCoords({ left: r.left + 1, top: r.top + r.height / 2 })?.pos
      lines.push({ top: r.top - editorTop - accum, pos: at != null && at > 0 ? at : startPos })
    }
  }
  lines.sort((a, b) => a.top - b.top)
  return lines
}

function compute(view: EditorView, pageH: number): { set: DecorationSet; sig: string } {
  if (pageH <= 0) return { set: DecorationSet.empty, sig: 'empty' }
  const editorTop = (view.dom as HTMLElement).getBoundingClientRect().top
  const doc = view.state.doc
  const childPos: number[] = []
  let pos = 0
  for (let i = 0; i < doc.childCount; i++) { childPos.push(pos); pos += doc.child(i).nodeSize }

  const lines = collectLines(view, editorTop, childPos)
  if (!lines.length) return { set: DecorationSet.empty, sig: 'empty' }

  const decos: Decoration[] = []
  const sig: string[] = []
  let used = 0
  let pageNo = 1
  for (let i = 0; i < lines.length; i++) {
    const lh = i < lines.length - 1 ? Math.max(1, lines[i + 1].top - lines[i].top) : 24
    // Break before the LINE that would overflow the page — splitting the paragraph if mid-block.
    if (i > 0 && used + lh > pageH && lines[i].pos > 0) {
      const gh = Math.max(GAP, pageH - used) + GAP
      const at = lines[i].pos
      const num = pageNo
      decos.push(Decoration.widget(at, () => gapEl(gh, num), { side: -1, key: `gap-${num}-${at}` }))
      sig.push(`${at}:${Math.round(gh)}:${num}`)
      pageNo++
      used = 0
    }
    used += lh
  }
  decos.push(Decoration.widget(doc.content.size, () => numEl(pageNo), { side: 1, key: `num-${pageNo}` }))
  sig.push(`end:${pageNo}`)
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
          let lastSig = ''
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
            // Reconcile the panel divs to match the segment list (reuse to avoid churn).
            while (layer.children.length > segs.length) layer.lastElementChild!.remove()
            while (layer.children.length < segs.length) {
              const d = document.createElement('div')
              d.className = 'inkwave-sheet'
              layer.appendChild(d)
            }
            segs.forEach((s, i) => {
              const d = layer!.children[i] as HTMLElement
              d.style.top = `${s.top}px`
              d.style.height = `${s.height}px`
            })
          }
          const schedulePaint = () => { if (!paintRaf) paintRaf = requestAnimationFrame(paint) }

          const recompute = () => {
            raf = 0
            ensureSheet()
            const pageH = (sheet ? sheet.clientWidth : 794) * Math.SQRT2
            if (sheet) sheet.classList.add('inkwave-gapped')
            const { set, sig } = compute(view, pageH)
            if (sig !== lastSig) { lastSig = sig; view.dispatch(view.state.tr.setMeta(KEY, set)) }
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
            },
          }
        },
      }),
    ]
  },
})
