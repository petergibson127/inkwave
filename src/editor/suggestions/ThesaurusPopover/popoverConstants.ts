export const CYCLE_SIZE      = 8
export const DELETE_SENTINEL = '\x00delete'
export const CARD_PAD_X      = 3

// Open/close reflow animation: the focused word's min-width and the surrounding letter-spacing
// transition over this duration (CSS-driven, so it stays smooth on phones). ~half an Apple
// keyboard raise. The close timer in usePopoverLayout matches it.
export const REFLOW_MS   = 140
export const REFLOW_EASE = 'cubic-bezier(0.4, 0, 0.2, 1)'

export interface CycleState {
  word: string
  from: number; to: number
  synonyms: string[]
  reelPos: number               // continuous (un-wrapped) scroll position, in slot units
  overlay: boolean              // touch/mobile: opaque floating card, no expand/compress
  minWidth: number; naturalWidth: number
  naturalLeft: number           // word's natural left edge (viewport px) — to align the reel
  alignFraction: number         // reel alignment fraction (from the line compression)
  naturalTop: number; naturalBottom: number; naturalLineRight: number
}

// Symmetric line compression. The focused word's reserved box (min-width) is centred on
// the word by compressing the text BEFORE it by half the expansion (which slides the box —
// and the before-neighbour — left by half), while the text AFTER it is compressed only by
// however much the resulting right-push exceeds the line's right-hand slack. Result: the
// box sits centred on the word, so the centred reel has even gaps and the word never moves.
export type LineRange = {
  from: number          // line start (first char on the focused word's visual line)
  firstWordEnd: number  // pos just after the line's first word (kept uncompressed)
  to: number            // line end
  lsBeforeEm: number    // letter-spacing reduction applied to [firstWordEnd, wordFrom]
  lsAfterEm: number     // letter-spacing reduction applied to [wordTo, to]
  alignFraction: number // fraction (beforeShift/exp) the box actually slid left — the reel
                        // aligns each word at this fraction so the original lands on its
                        // natural x for any position (0=left-edge, .5=centred, 1=right-edge)
}

export type OnHintChange = (
  pos: number | null,
  minWidth?: number | null,
  lineRange?: LineRange | null,
  animate?: boolean,        // false = apply this state instantly (no CSS transition); default true
) => void
