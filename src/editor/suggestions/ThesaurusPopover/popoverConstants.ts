export const CYCLE_SIZE      = 8
export const DELETE_SENTINEL = '\x00delete'
export const CARD_PAD_X      = 3

export interface CycleState {
  word: string
  from: number; to: number
  synonyms: string[]; currentIdx: number
  reelPos: number               // continuous (un-wrapped) position for the slide animation
  minWidth: number; naturalWidth: number
  naturalTop: number; naturalBottom: number; naturalLineRight: number
}

export type LineRange = {
  from: number; to: number; letterSpacingEm: number; offsetLeft: number
}

export type OnHintChange = (
  pos: number | null,
  minWidth?: number | null,
  lineRange?: LineRange | null,
) => void
