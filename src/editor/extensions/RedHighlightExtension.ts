import { Extension } from '@tiptap/react'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import { isInVocab } from '../../scas/ranking'
import type { InkwaveDocument } from '../../types/document'
import type { LineRange } from '../suggestions/ThesaurusPopover/popoverConstants'

export const RED_HIGHLIGHT_KEY = new PluginKey<DecorationSet>('redHighlight')

// Dispatch a transaction with this meta key to force a hint rebuild without
// changing the document (e.g. when the popover opens or closes).
export const SCAS_HINT_META = 'scasHintUpdate'

const WORD_RE = /[a-zA-Z]+/g

export interface HintState {
  focusedPos: number | null
  showHints: boolean
  focusedMinWidth: number | null
  // Symmetric letter-spacing compression around the focused word that centres its
  // reserved box on the word (see LineRange) — before-side slides the box left by half
  // the expansion, after-side absorbs the rest of the rightward push past the slack.
  lineCompressionRange: LineRange | null
}

interface RedHighlightOptions {
  getDoc: () => InkwaveDocument
  getHintState: () => HintState
}

export const RedHighlightExtension = Extension.create<RedHighlightOptions>({
  name: 'redHighlight',

  addOptions() {
    return {
      getDoc: () => { throw new Error('RedHighlightExtension: getDoc option is required') },
      getHintState: () => ({ focusedPos: null, showHints: true, focusedMinWidth: null, lineCompressionRange: null }),
    }
  },

  addProseMirrorPlugins() {
    const { getDoc, getHintState } = this.options
    return [
      new Plugin({
        key: RED_HIGHLIGHT_KEY,
        state: {
          init(_, state) {
            return buildDecorations(state.doc, getDoc(), state.selection.from, getHintState())
          },
          apply(tr, old, prev, next) {
            return !tr.docChanged && tr.selection.eq(prev.selection) && !tr.getMeta(SCAS_HINT_META)
              ? old
              : buildDecorations(next.doc, getDoc(), next.selection.from, getHintState())
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
}

function buildDecorations(
  pmDoc: PMNode,
  inkDoc: InkwaveDocument,
  cursorPos: number,
  hintState: HintState,
): DecorationSet {
  const { scasLimitN, scasSessionSeed } = inkDoc
  if (scasLimitN === 'infinite') return DecorationSet.empty

  // ── 1. Collect out-of-vocab words (skip uncommitted cursor word) ──────────
  const redWords: RedWord[] = []
  let paragraphIndex = 0

  pmDoc.descendants((node: PMNode, pos: number) => {
    if (node.type.name !== 'paragraph') return true
    const pIdx = paragraphIndex++
    let seqInPara = 0

    node.forEach((child: PMNode, offset: number) => {
      if (!child.isText || !child.text) return
      const text = child.text
      // A SCAS-managed run (a previously-cycled word) stays red regardless of vocab,
      // and its synonym list stays anchored to the original word stored on the mark.
      const slotMark = child.marks.find(m => m.type.name === 'scasSlot')
      const slotOriginal = (slotMark?.attrs.original as string | null) ?? null
      let match: RegExpExecArray | null
      WORD_RE.lastIndex = 0
      while ((match = WORD_RE.exec(text)) !== null) {
        const word = match[0]
        if (word.length < 2) continue
        const from = pos + 1 + offset + match.index
        const to   = from + word.length

        if (!slotMark) {
          // Skip the word under the cursor unless it's already been committed
          // (committed = a space or punctuation immediately follows it).
          if (cursorPos >= from && cursorPos <= to) {
            const nextChar = text[match.index + word.length] ?? null
            if (!nextChar || !/[\s.,;:!?)\-'"…]/.test(nextChar)) continue
          }
          if (isInVocab(word, pIdx, scasSessionSeed, scasLimitN)) continue
        }

        redWords.push({
          from, to, pIdx, word, seqInPara: ++seqInPara,
          dataWord: slotOriginal ?? word.toLowerCase(),
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

  for (const { from, to, dataWord, pIdx, seqInPara } of redWords) {
    const isFocused = focusedPos !== null && from === focusedPos
    const attrs: Record<string, string> = {
      class: isFocused ? 'scas-red scas-focused' : 'scas-red',
      'data-word': dataWord,
      'data-para': String(pIdx),
      'data-scas-n': String(seqInPara),
    }
    const hint = hintMap.get(from)
    if (hint) attrs['data-hint'] = hint

    if (isFocused) {
      const mw = hintState.focusedMinWidth
      attrs['style'] = `display:inline-block;color:transparent${mw ? `;min-width:${Math.ceil(mw)}px` : ''}`
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
      if (lsBeforeEm > 0 && fwe < fw.from) {
        decorations.push(Decoration.inline(fwe, fw.from, { style: `letter-spacing: -${lsBeforeEm.toFixed(4)}em` }))
      }
      if (lsAfterEm > 0 && fw.to < lt) {
        decorations.push(Decoration.inline(fw.to, lt, { style: `letter-spacing: -${lsAfterEm.toFixed(4)}em` }))
      }
    }
  }

  return DecorationSet.create(pmDoc, decorations)
}
