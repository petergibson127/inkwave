import { Extension } from '@tiptap/react'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import { lemmaOf, inPool } from '../../scas/engine'
import { isColoured, type ScasLookup } from '../../scas/state'

// TEMPORARY debug aid (NOT for the final product — a no-paste feature is coming): highlight EVERY
// constrainable (pool) word, so pasted/typed text lights up densely for testing the word-cycle
// animation. Off by default. Turn on with `?debughl=1` (works on the live site too) or via the
// dev-only Options menu toggle (localStorage `inkwave:debugHighlightAll`).
function debugHighlightAll(): boolean {
  if (typeof window === 'undefined') return false
  try {
    if (new URLSearchParams(window.location.search).get('debughl') === '1') return true
    return window.localStorage.getItem('inkwave:debugHighlightAll') === '1'
  } catch {
    return false
  }
}
import type { InkwaveDocument } from '../../types/document'
import { REFLOW_OPEN_MS, REFLOW_EASE, type LineRange, type SlideRange } from '../suggestions/ThesaurusPopover/popoverConstants'

export const RED_HIGHLIGHT_KEY = new PluginKey<DecorationSet>('redHighlight')

// Dispatch a transaction with this meta key to force a hint rebuild without
// changing the document (e.g. when the popover opens or closes).
export const SCAS_HINT_META = 'scasHintUpdate'

const WORD_RE = /[a-zA-Z]+/g

export interface HintState {
  focusedPos: number | null
  showHints: boolean
  focusedMinWidth: number | null
  // Right-preferring letter-spacing compression around the focused word (see LineRange):
  // the after-side absorbs the box expansion so the word keeps its natural x; the before-side
  // only compresses when the word is too near the margin for the right to take it all.
  lineCompressionRange: LineRange | null
  // Whether the min-width / letter-spacing changes should CSS-transition. False applies them
  // instantly — used for the START (jump-to-natural) of an open and for snap (wrap) commits, so
  // a reused decoration node never animates from the previous word's reserved width (overflow flash).
  animate: boolean
  // Transition duration for this change (open is snappy, commit/close is a slower settle).
  durationMs: number
  // Post-commit slide-in (independent of focusedPos, so it survives the cycle teardown): render
  // [from,to] — the rest of the committed word's visual line, including any word that rewrapped up
  // onto it — as one inline-block translated by `px`, eased to 0 so the after-text (and the joining
  // word, flush) slides in from the right while the lines below snap. null = inactive.
  slideRange: SlideRange | null
}

const EMPTY_LOOKUP: ScasLookup = {
  version: 0,
  locked: new Set(),
  liveKicks: new Set(),
  immune: new Set(),
}

interface RedHighlightOptions {
  getDoc: () => InkwaveDocument
  getHintState: () => HintState
  getScasLookup: () => ScasLookup
}

export const RedHighlightExtension = Extension.create<RedHighlightOptions>({
  name: 'redHighlight',

  addOptions() {
    return {
      getDoc: () => { throw new Error('RedHighlightExtension: getDoc option is required') },
      getHintState: () => ({ focusedPos: null, showHints: true, focusedMinWidth: null, lineCompressionRange: null, animate: true, durationMs: REFLOW_OPEN_MS, slideRange: null }),
      getScasLookup: () => EMPTY_LOOKUP,
    }
  },

  addProseMirrorPlugins() {
    const { getDoc, getHintState, getScasLookup } = this.options
    return [
      new Plugin({
        key: RED_HIGHLIGHT_KEY,
        state: {
          init(_, state) {
            return buildDecorations(state.doc, getDoc(), state.selection.from, getHintState(), getScasLookup())
          },
          apply(tr, old, prev, next) {
            return !tr.docChanged && tr.selection.eq(prev.selection) && !tr.getMeta(SCAS_HINT_META)
              ? old
              : buildDecorations(next.doc, getDoc(), next.selection.from, getHintState(), getScasLookup())
          },
        },
        props: {
          decorations(state) { return RED_HIGHLIGHT_KEY.getState(state) },
        },
      }),
    ]
  },
})

// ---------------------------------------------------------------------------

interface RedWord {
  from: number
  to: number
  pIdx: number
  word: string
  dataWord: string   // synonym-lookup key: the slot's original word (= word, unless managed)
  seqInPara: number  // 1-based — kept for data-scas-n (debugging / future use)
  secondary: boolean // a managed slot whose current text differs from its original — a substituted
                     // word. Rendered the lighter purple (matches the reel's candidate colour) so a
                     // committed synonym keeps its colour.
}

function buildDecorations(
  pmDoc: PMNode,
  inkDoc: InkwaveDocument,
  cursorPos: number,
  hintState: HintState,
  lookup: ScasLookup,
): DecorationSet {
  // SCAS engine off (un-migrated or non-N-mode) → no decorations.
  if (inkDoc.scasMode !== 'n' || !inkDoc.scasState) return DecorationSet.empty

  // ── 1. Collect kicked words (skip the uncommitted word under the cursor) ──────
  // A word is purple iff its lemma is Locked or an outstanding live kick — the frozen verdict
  // from the SCAS controller, NOT a recompute against the current S_v (so rotation never reflows
  // already-committed text). `lemmaOf` collapses inflections to the state key.
  const redWords: RedWord[] = []
  let paragraphIndex = 0
  const debugAll = debugHighlightAll() // temporary: colour every pool word for animation testing

  pmDoc.descendants((node: PMNode, pos: number) => {
    if (node.type.name !== 'paragraph') return true
    const pIdx = paragraphIndex++
    let seqInPara = 0

    node.forEach((child: PMNode, offset: number) => {
      if (!child.isText || !child.text) return
      const text = child.text
      // The slot mark anchors a cycled word's synonym list to its original; it no longer forces
      // colour — colour is driven entirely by engine state.
      const slotMark = child.marks.find(m => m.type.name === 'scasSlot')
      const slotOriginal = (slotMark?.attrs.original as string | null) ?? null
      let match: RegExpExecArray | null
      WORD_RE.lastIndex = 0
      while ((match = WORD_RE.exec(text)) !== null) {
        const word = match[0]
        if (word.length < 2) continue
        const from = pos + 1 + offset + match.index
        const to   = from + word.length

        // Skip the word under the cursor unless it's already committed (a boundary char follows).
        if (cursorPos >= from && cursorPos <= to) {
          const nextChar = text[match.index + word.length] ?? null
          if (!nextChar || !/[\s.,;:!?)\-'"…]/.test(nextChar)) continue
        }

        const lemma = lemmaOf(word)
        if (!isColoured(lookup, lemma) && !(debugAll && inPool(lemma))) continue

        redWords.push({
          from, to, pIdx, word, seqInPara: ++seqInPara,
          dataWord: slotOriginal ?? word.toLowerCase(),
          secondary: !!slotOriginal && word.toLowerCase() !== slotOriginal.toLowerCase(),
        })
      }
    })

    return false
  })

  // ── 2. Hint badges (tab / ⇧+tab on the two nearest red words) ────────────
  const hintMap = new Map<number, string>()
  if (hintState.showHints) {
    // When the popover is open use the focused word as the reference point;
    // otherwise use the cursor. Either way, hint the neighbours of that point.
    const ref      = hintState.focusedPos ?? cursorPos
    const prevWord = [...redWords].reverse().find(rw => rw.from < ref)
    const nextWord = redWords.find(rw => rw.from > ref)
    if (prevWord) hintMap.set(prevWord.from, 'tab')
    if (nextWord) hintMap.set(nextWord.from, '⇧+tab')
  }

  // ── 3. Build decorations ──────────────────────────────────────────────────
  const decorations: Decoration[] = []
  const { focusedPos } = hintState

  for (const { from, to, dataWord, pIdx, seqInPara, secondary } of redWords) {
    const isFocused = focusedPos !== null && from === focusedPos
    const attrs: Record<string, string> = {
      class: `scas-red${isFocused ? ' scas-focused' : ''}${secondary ? ' scas-secondary' : ''}`,
      'data-word': dataWord,
      'data-para': String(pIdx),
      'data-scas-n': String(seqInPara),
    }
    const hint = hintMap.get(from)
    if (hint) attrs['data-hint'] = hint

    if (isFocused) {
      const mw = hintState.focusedMinWidth
      const trans = hintState.animate ? `transition:min-width ${hintState.durationMs}ms ${REFLOW_EASE}` : 'transition:none'
      // Use the EXACT reserved width (not Math.ceil): ceiling rounds the box up by up to 1px, so on
      // commit the after-text sat ~1px right of where the committed (exact-width) text lands and
      // snapped left at the swap — the end-of-motion twitch, worst on short words. Sub-pixel
      // min-width is fine; the box now matches the committed glyph run.
      attrs['style'] = `display:inline-block;color:transparent${mw ? `;min-width:${mw.toFixed(2)}px` : ''};${trans}`
    }

    decorations.push(Decoration.inline(from, to, attrs))
  }

  // Symmetric line compression: squeeze the before-side (after the line's first word) to
  // slide the focused word's reserved box left by half its expansion — centring it on the
  // word — and squeeze the after-side only by the right-push that exceeds the slack.
  const { lineCompressionRange } = hintState
  if (lineCompressionRange && focusedPos !== null) {
    const fw = redWords.find(rw => rw.from === focusedPos)
    if (fw) {
      const { firstWordEnd: fwe, to: lt, lsBeforeEm, lsAfterEm } = lineCompressionRange
      const lsTransition = hintState.animate ? `;transition:letter-spacing ${hintState.durationMs}ms ${REFLOW_EASE}` : ';transition:none'
      // Apply the span whenever its range exists (even at letter-spacing 0): a 0 span is a
      // visual no-op but must be present so the open/close transition has something to animate.
      if (fwe < fw.from) {
        // Mirror of the after-run, but transform-origin RIGHT: the before-run's right edge is glued
        // to the (fixed) focused word, so it compresses/de-compresses toward the word. When
        // beforeSlidePx is set (FLIP), render it as a transformable inline-block carrying the invert
        // translateX + scaleX and transition the TRANSFORM (compositor, lag-free) — so the LHS
        // animates instead of snapping. Otherwise a plain inline letter-spacing span.
        const bslide = lineCompressionRange.beforeSlidePx
        const bsx = lineCompressionRange.beforeScaleX ?? 1
        const beforeStyle = bslide !== undefined
          ? `letter-spacing: -${lsBeforeEm.toFixed(4)}em;display:inline-block;white-space:pre;transform-origin:right center;transform:translateX(${bslide.toFixed(2)}px) scaleX(${bsx.toFixed(4)});` +
            (hintState.animate ? `transition:transform ${hintState.durationMs}ms ${REFLOW_EASE}` : 'transition:none')
          : `letter-spacing: -${lsBeforeEm.toFixed(4)}em${lsTransition}`
        decorations.push(Decoration.inline(fwe, fw.from, { class: 'scas-comp-before', style: beforeStyle }))
      }
      if (fw.to < lt) {
        // The after-run carries a stable class so the FLIP commit (?flip=1) can find it.
        // When afterSlidePx is set (FLIP), render it as a transformable inline-block carrying the
        // invert translateX and transition the TRANSFORM — driven by the decoration so PM's
        // reconciler keeps it (a manual DOM style edit gets reverted within a frame). Otherwise
        // it's a plain inline letter-spacing span that transitions letter-spacing.
        const slide = lineCompressionRange.afterSlidePx
        const asx = lineCompressionRange.afterScaleX ?? 1
        const afterStyle = slide !== undefined
          ? `letter-spacing: -${lsAfterEm.toFixed(4)}em;display:inline-block;white-space:pre;transform-origin:left center;transform:translateX(${slide.toFixed(2)}px) scaleX(${asx.toFixed(4)});` +
            (hintState.animate ? `transition:transform ${hintState.durationMs}ms ${REFLOW_EASE}` : 'transition:none')
          : `letter-spacing: -${lsAfterEm.toFixed(4)}em${lsTransition}`
        decorations.push(Decoration.inline(fw.to, lt, { class: 'scas-comp-after', style: afterStyle }))
      }
    }
  }

  // Post-commit slide-in: render [from,to] (the rest of the committed word's visual line, incl. a
  // word that rewrapped up onto it) as ONE inline-block translated by px, eased to 0 — so the
  // after-text and the joining word slide in flush from the right while the lines below snap.
  // Built post-swap on the FINAL layout, so the inline-block fits its line (no wrap-drop); the
  // translateX is purely visual overflow during the transient. Independent of focusedPos.
  const { slideRange } = hintState
  if (slideRange) {
    const tr = hintState.animate ? `transition:transform ${hintState.durationMs}ms ${REFLOW_EASE}` : 'transition:none'
    if (slideRange.to > slideRange.from) {
      const sx = slideRange.scaleX ?? 1
      // transform-origin left: scaleX expands from the run's left edge (anchored at the committed
      // word) so the start matches the cycle's compressed run exactly; eases to scaleX(1).
      decorations.push(Decoration.inline(slideRange.from, slideRange.to, {
        class: 'scas-slide-after',
        style: `display:inline-block;white-space:pre;transform-origin:left center;transform:translateX(${slideRange.px.toFixed(2)}px) scaleX(${sx.toFixed(4)});${tr}`,
      }))
    }
    // Before-run on commit: origin-RIGHT (glued to the committed word) so it de-compresses toward
    // the word, mirroring the after-run — so the LHS animates on commit instead of snapping.
    const b = slideRange.before
    if (b && b.to > b.from) {
      const bsx = b.scaleX ?? 1
      decorations.push(Decoration.inline(b.from, b.to, {
        class: 'scas-slide-before',
        style: `display:inline-block;white-space:pre;transform-origin:right center;transform:translateX(${b.px.toFixed(2)}px) scaleX(${bsx.toFixed(4)});${tr}`,
      }))
    }
  }

  return DecorationSet.create(pmDoc, decorations)
}
