import { Extension } from '@tiptap/react'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import { isInVocab } from '../../scas/ranking'
import type { InkwaveDocument } from '../../types/document'

export const RED_HIGHLIGHT_KEY = new PluginKey<DecorationSet>('redHighlight')

const WORD_RE = /[a-zA-Z]+/g

interface RedHighlightOptions {
  getDoc: () => InkwaveDocument
}

export const RedHighlightExtension = Extension.create<RedHighlightOptions>({
  name: 'redHighlight',

  addOptions() {
    return {
      getDoc: () => {
        throw new Error('RedHighlightExtension: getDoc option is required')
      },
    }
  },

  addProseMirrorPlugins() {
    const getDoc = this.options.getDoc

    return [
      new Plugin({
        key: RED_HIGHLIGHT_KEY,

        state: {
          init(_, state) {
            return buildDecorations(state.doc, getDoc(), state.selection.from)
          },
          apply(tr, oldDecos, _oldState, newState) {
            if (!tr.docChanged && tr.selection.eq(_oldState.selection)) return oldDecos
            return buildDecorations(newState.doc, getDoc(), newState.selection.from)
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

function buildDecorations(pmDoc: PMNode, inkDoc: InkwaveDocument, cursorPos: number): DecorationSet {
  const { scasLimitN, scasSessionSeed } = inkDoc

  if (scasLimitN === 'infinite') return DecorationSet.empty

  const decorations: Decoration[] = []
  let paragraphIndex = 0

  pmDoc.descendants((node: PMNode, pos: number) => {
    if (node.type.name !== 'paragraph') {
      if (node.type.name !== 'doc') paragraphIndex++
      return true
    }

    const pIdx = paragraphIndex
    paragraphIndex++

    let wordIndexInParagraph = 0

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

        // Don't highlight the word the cursor is currently inside.
        if (cursorPos >= from && cursorPos <= to) continue

        if (isInVocab(word, pIdx, scasSessionSeed, scasLimitN)) continue

        wordIndexInParagraph++

        decorations.push(
          Decoration.inline(from, to, {
            class: 'scas-red',
            'data-word': word.toLowerCase(),
            'data-para': String(pIdx),
            'data-scas-n': String(wordIndexInParagraph),
          })
        )
      }
    })

    return false
  })

  return DecorationSet.create(pmDoc, decorations)
}
