import { useEffect, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { getSynonyms } from '../thesaurus'
import { getFont } from '../textMetrics'
import { CYCLE_SIZE, DELETE_SENTINEL } from './popoverConstants'
import type { CycleState, OnHintChange } from './popoverConstants'
import { posOf, measureNaturalLineRight, computeLineCompressionRange } from './popoverGeometry'
import { buildSynonyms } from './popoverFallbacks'

export function usePopoverLayout(
  editor: Editor,
  onHintChange: OnHintChange,
) {
  const [cycle, setCycle] = useState<CycleState | null>(null)
  const [, forceUpdate]   = useState(0)

  // Re-render on resize/scroll so live DOM positions stay in sync.
  useEffect(() => {
    if (!cycle) return
    const upd = () => forceUpdate(n => n + 1)
    window.addEventListener('resize', upd)
    window.addEventListener('scroll', upd, true)
    return () => { window.removeEventListener('resize', upd); window.removeEventListener('scroll', upd, true) }
  }, [!!cycle]) // eslint-disable-line react-hooks/exhaustive-deps

  // Reapply compression on resize or when cycle geometry changes.
  // The initial application is done synchronously inside openCycleForElement
  // (single PM dispatch). This is a safety net for reflow events.
  useEffect(() => {
    if (!cycle) return
    function recompress() {
      const fe = editor.view.dom.querySelector('.scas-focused') as HTMLElement | null
      const pe = fe?.closest('p')
      if (!fe || !pe) return
      onHintChange(cycle!.from, cycle!.minWidth, computeLineCompressionRange(
        cycle!.naturalTop, cycle!.naturalBottom, cycle!.naturalLineRight,
        cycle!.naturalWidth, cycle!.minWidth, cycle!.from, cycle!.to, pe, editor,
      ))
    }
    recompress()
    window.addEventListener('resize', recompress)
    return () => window.removeEventListener('resize', recompress)
  }, [cycle?.from, cycle?.minWidth]) // eslint-disable-line react-hooks/exhaustive-deps

  function openCycleForElement(target: HTMLElement) {
    const displayWord = target.textContent ?? ''
    const lookupWord  = target.dataset.word ?? displayWord.toLowerCase()
    if (!lookupWord) return

    let domPos: number
    try { domPos = editor.view.posAtDOM(target.firstChild ?? target, 0) } catch { return }

    // Clear existing decoration synchronously — PM dispatch is sync so the DOM
    // reverts to natural layout before we measure.
    onHintChange(null, null)

    // Re-acquire a live element: the PM rebuild above may have destroyed the
    // original target if the previous compression range covered this word.
    const reds = Array.from(editor.view.dom.querySelectorAll<HTMLElement>('.scas-red'))
    const live = reds.find(el => posOf(el, editor) === domPos)
    if (!live) return

    const rect   = live.getBoundingClientRect()
    const font   = getFont(live)
    const pEl    = live.closest('p')
    const natRight = pEl ? measureNaturalLineRight(rect, pEl) : rect.right

    // Apply provisional focus immediately to prevent the null-gap flash on Tab nav.
    onHintChange(domPos, rect.width)
    setCycle({
      word: lookupWord, from: domPos, to: domPos + displayWord.length,
      synonyms: Array(CYCLE_SIZE).fill(displayWord),
      reelPos: 0,
      minWidth: rect.width, naturalWidth: rect.width,
      naturalTop: rect.top, naturalBottom: rect.bottom, naturalLineRight: natRight,
    })

    getSynonyms(lookupWord).then(candidates => {
      // Bail if the cycle closed or another word was focused while fetching.
      const fe = editor.view.dom.querySelector('.scas-focused') as HTMLElement | null
      if (!fe || posOf(fe, editor) !== domPos) return

      // Slot 0 is the ORIGINAL word (lookupWord = the managed slot's original, or the
      // word itself when unmanaged), so a managed word re-offers the original's list.
      const { synonyms, minWidth } = buildSynonyms(lookupWord, candidates, font, rect.width)
      const pe = (fe.closest('p') ?? pEl) as Element | null
      // Compute compression atomically with min-width — single PM dispatch, no overflow frame.
      const lineRange = pe
        ? computeLineCompressionRange(rect.top, rect.bottom, natRight,
            rect.width, minWidth, domPos, domPos + displayWord.length, pe, editor)
        : null
      // Centre the reel on the word currently in the text (may differ from the original
      // for a managed slot), so reopening shows what's there, not the original.
      const cur = displayWord.toLowerCase()
      let reelPos = synonyms.findIndex(s => s !== DELETE_SENTINEL && s.toLowerCase() === cur)
      if (reelPos < 0) reelPos = 0
      onHintChange(domPos, minWidth, lineRange)
      setCycle(prev => prev?.from === domPos ? { ...prev, synonyms, minWidth, reelPos } : prev)
    })
  }

  return { cycle, setCycle, openCycleForElement }
}
