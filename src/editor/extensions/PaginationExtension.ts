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
const GAP = 40 // px of aqua between sheets

export interface PaginationOptions { enabled: boolean }

function gapEl(heightPx: number, pageNum: number): HTMLElement {
  const el = document.createElement('div')
  el.className = 'inkwave-page-gap'
  el.style.height = `${Math.round(heightPx)}px`
  el.contentEditable = 'false'
  const span = document.createElement('span')
  span.textContent = String(pageNum)
  el.appendChild(span)
  return el
}

function numEl(pageNum: number): HTMLElement {
  const el = document.createElement('div')
  el.className = 'inkwave-page-num'
  el.contentEditable = 'false'
  el.textContent = String(pageNum)
  return el
}

function compute(view: EditorView, pageH: number): { set: DecorationSet; sig: string } {
  const dom = view.dom as HTMLElement
  const editorTop = dom.getBoundingClientRect().top
  // Intrinsic block tops: subtract the heights of our own gap widgets above each block.
  let accum = 0
  const tops: number[] = []
  const heights: number[] = []
  for (const child of Array.from(dom.children) as HTMLElement[]) {
    if (child.classList.contains('inkwave-page-gap')) { accum += child.getBoundingClientRect().height; continue }
    const r = child.getBoundingClientRect()
    tops.push(r.top - editorTop - accum)
    heights.push(r.height)
  }
  const n = tops.length
  if (!n || pageH <= 0) return { set: DecorationSet.empty, sig: 'empty' }

  const doc = view.state.doc
  const childPos: number[] = []
  let pos = 0
  for (let i = 0; i < doc.childCount; i++) { childPos.push(pos); pos += doc.child(i).nodeSize }

  const decos: Decoration[] = []
  const sig: string[] = []
  let used = 0
  let pageNo = 1
  for (let i = 0; i < n; i++) {
    const occ = i < n - 1 ? tops[i + 1] - tops[i] : heights[i] // flow occupancy (incl. margin)
    if (i > 0 && used + occ > pageH && childPos[i] != null) {
      const gh = Math.max(GAP, pageH - used + GAP) // fill the rest of this page + the gap
      const at = childPos[i]
      const num = pageNo
      decos.push(Decoration.widget(at, () => gapEl(gh, num), { side: -1, key: `gap-${num}` }))
      sig.push(`${at}:${Math.round(gh)}:${num}`)
      pageNo++
      used = 0
    }
    used += occ
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
          let lastSig = ''
          const recompute = () => {
            raf = 0
            const sheet = (view.dom as HTMLElement).closest('.scroll-paper') as HTMLElement | null
            const pageH = (sheet ? sheet.clientWidth : 794) * Math.SQRT2
            const { set, sig } = compute(view, pageH)
            if (sig !== lastSig) { lastSig = sig; view.dispatch(view.state.tr.setMeta(KEY, set)) }
          }
          const schedule = () => { if (!raf) raf = requestAnimationFrame(recompute) }
          const sheet = (view.dom as HTMLElement).closest('.scroll-paper')
          const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null
          if (ro && sheet) ro.observe(sheet)
          schedule()
          return {
            update: schedule,
            destroy() { ro?.disconnect(); if (raf) cancelAnimationFrame(raf) },
          }
        },
      }),
    ]
  },
})
