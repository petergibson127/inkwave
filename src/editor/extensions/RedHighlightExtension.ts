import { Extension } from '@tiptap/react'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import { isInVocab } from '../../scas/ranking'
import type { InkwaveDocument } from '../../types/document'

export const RED_HIGHLIGHT_KEY = new PluginKey<DecorationSet>('redHighlight')

// Dispatch a transaction with this meta key to force a hint rebuild without
// changing the document (e.g. when the popover opens or closes).
export const SCAS_HINT_META = 'scasHintUpdate'

const WORD_RE = /[a-zA-Z]+/g

export interface HintState {
  focusedPos: number | null     // ProseMirror position of the currently open word
  showHints: boolean
  focusedMinWidth: number | null  // px width to reserve on the focused word span
}

interface RedHighlightOptions {
  getDoc: () => InkwaveDocument
  getHintState: () => HintState
}

export const RedHighlightExtension = Extension.create<RedHighlightOptions>({
  name: 'redHighlight',

  addOptions() {
    return {
      getDoc: () => {
        throw new Error('RedHighlightExtension: getDoc option is required')
      },
      getHintState: () => ({ focusedPos: null, showHints: true, focusedMinWidth: null }),
    }
  },

  addProseMirrorPlugins() {
    const getDoc = this.options.getDoc
    const getHintState = this.options.getHintState

    return [
      new Plugin({
        key: RED_HIGHLIGHT_KEY,

        state: {
          init(_, state) {
            return buildDecorations(state.doc, getDoc(), state.selection.from, getHintState())
          },
          apply(tr, oldDecos, _oldState, newState) {
            if (
              !tr.docChanged &&
              tr.selection.eq(_oldState.selection) &&
              !tr.getMeta(SCAS_HINT_META)
            ) return oldDecos
            return buildDecorations(newState.doc, getDoc(), newState.selection.from, getHintState())
          },
        },

        props: {
          decorations(state) {
            return RED_HIGHLIGHT_KEY.getState(state)
          },
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
  seqInPara: number  // 1-based, kept for data-scas-n (debugging / future use)
}

function buildDecorations(
  pmDoc: PMNode,
  inkDoc: InkwaveDocument,
  cursorPos: number,
  hintState: HintState,
): DecorationSet {
  const { scasLimitN, scasSessionSeed } = inkDoc

  if (scasLimitN === 'infinite') return DecorationSet.empty

  // ── 1. Collect every out-of-vocab word (skip cursor word) ────────────────
  const redWords: RedWord[] = []
  let paragraphIndex = 0
  let cursorParaIdx = 0

  pmDoc.descendants((node: PMNode, pos: number) => {
    if (node.type.name !== 'paragraph') return true

    const pIdx = paragraphIndex
    paragraphIndex++

    // Track which paragraph the cursor is in.
    const paraStart = pos + 1
    const paraEnd = pos + node.nodeSize - 1
    if (cursorPos >= paraStart && cursorPos <= paraEnd) cursorParaIdx = pIdx

    let seqInPara = 0

    node.forEach((child: PMNode, offset: number) => {
      if (!child.isText || !child.text) return

      const text = child.text
      let match: RegExpExecArray | null

      WORD_RE.lastIndex = 0
      while ((match = WORD_RE.exec(text)) !== null) {
        const word = match[0]
        if (word.length < 2) continue

        const from = pos + 1 + offset + match.index
        const to = from + word.length

        if (cursorPos >= from && cursorPos <= to) continue
        if (isInVocab(word, pIdx, scasSessionSeed, scasLimitN)) continue

        seqInPara++
        redWords.push({ from, to, pIdx, word, seqInPara })
      }
    })

    return false
  })

  // ── 2. Determine which words get hint badges ──────────────────────────────
  // Hints are only shown on the two nearest red words in the relevant paragraph
  // (the one containing the cursor, or the one containing the focused word).
  // Tab = backward → prev word gets 'tab'.
  // Shift+Tab = forward → next word gets '⇧+tab'.
  const hintMap = new Map<number, string>() // from → hint label

  if (hintState.showHints) {
    const { focusedPos } = hintState

    if (focusedPos === null) {
      // No popover: hint the nearest red words before and after the cursor,
      // crossing paragraph boundaries if needed.
      const prevWord = [...redWords].reverse().find(rw => rw.from < cursorPos)
      const nextWord = redWords.find(rw => rw.from > cursorPos)
      if (prevWord) hintMap.set(prevWord.from, 'tab')
      if (nextWord) hintMap.set(nextWord.from, '⇧+tab')
    } else {
      // Popover open: hint the neighbours of the focused word,
      // crossing paragraph boundaries if needed.
      const prevWord = [...redWords].reverse().find(rw => rw.from < focusedPos)
      const nextWord = redWords.find(rw => rw.from > focusedPos)
      if (prevWord) hintMap.set(prevWord.from, 'tab')
      if (nextWord) hintMap.set(nextWord.from, '⇧+tab')
    }
  }

  // ── 3. Build decorations ──────────────────────────────────────────────────
  const decorations: Decoration[] = []
  const { focusedPos } = hintState

  for (const { from, to, word, pIdx, seqInPara } of redWords) {
    const hint = hintMap.get(from)
    const isFocused = focusedPos !== null && from === focusedPos
    const attrs: Record<string, string> = {
      class: isFocused ? 'scas-red scas-focused' : 'scas-red',
      'data-word': word.toLowerCase(),
      'data-para': String(pIdx),
      'data-scas-n': String(seqInPara),
    }
    if (hint) attrs['data-hint'] = hint

    if (isFocused) {
      // Make the span inline-block so min-width works, and hide its text so
      // the ThesaurusPopover overlay can render the current synonym on top.
      const mw = hintState.focusedMinWidth
      attrs['style'] = `display:inline-block;color:transparent${mw ? `;min-width:${Math.ceil(mw)}px` : ''}`
    }

    decorations.push(Decoration.inline(from, to, attrs))
  }

  return DecorationSet.create(pmDoc, decorations)
}
