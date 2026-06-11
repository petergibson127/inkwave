export const CYCLE_SIZE      = 8
export const DELETE_SENTINEL = '\x00delete'
export const CARD_PAD_X      = 3

// Cap on the RIGHT-side compression RATE (letter-spacing em per character). The after-text
// squeezes at most this much per character — so a word near the right margin, with only a few
// characters after it, never gets crammed (the real cause of the "strict" look). Whatever the
// right can't absorb at this gentle rate compresses the LEFT (before-text, which usually has far
// more characters to spread it over) up to MAX_LS_EM. Box still fits the widest synonym (no clip).
export const MAX_RIGHT_LS_EM = 0.04


// Reflow animation (CSS-driven, smooth on phones). The OPEN is snappy; the COMMIT/close settle
// is slower and gentler. easeOutQuint decelerates smoothly into place (no harsh stop).
// Debug knob: ?slow=N multiplies the COMMIT duration (the word slide-home, reel glide and FLIP
// after-text return) so the animation can be eyeballed frame-by-frame. Default 1 = 240ms.
function commitSlowFactor(): number {
  if (typeof window === 'undefined') return 1
  try {
    const s = new URLSearchParams(window.location.search).get('slow')
    const n = s ? parseFloat(s) : NaN
    return Number.isFinite(n) && n > 0 ? n : 1
  } catch { return 1 }
}
export const REFLOW_OPEN_MS   = 120
export const REFLOW_COMMIT_MS = Math.round(240 * commitSlowFactor())
export const REFLOW_EASE      = 'cubic-bezier(0.22, 1, 0.36, 1)'

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
  afterSlidePx?: number // OPEN animation: render the after-run as inline-block with
                        // transform:translateX(this) so it slides on the compositor (driven through
                        // the decoration so PM's reconciler keeps it). undefined = plain inline span.
  afterScaleX?: number  // paired with afterSlidePx: horizontal scale (origin-left) animating the
                        // COMPRESSION as the run slides out on open (starts stretched/de-compressed
                        // >1, eases to 1) — the mirror of the commit's scaleX. Default 1.
  beforeSlidePx?: number // LHS analogue of afterSlidePx — the before-run is rendered inline-block,
                         // transform-origin RIGHT (glued to the fixed word), translated by this so it
                         // animates on the compositor instead of snapping. undefined = plain span.
  beforeScaleX?: number  // paired with beforeSlidePx: horizontal scale (origin-right) animating the
                         // before-run's compression/de-compression. Default 1.
}

// Post-commit slide-in range (see HintState.slideRange in RedHighlightExtension). `px` is the
// translateX, `scaleX` the horizontal scale (origin-left) that animates the after-text's
// de-compression: starting scaled to its compressed width so the slide begins looking exactly like
// the cycle, easing to 1 (full/de-compressed) — no "extend out" pop. Omitted scaleX = 1.
export type SlideRange = { from: number; to: number; px: number; scaleX?: number }

export type OnHintChange = (
  pos: number | null,
  minWidth?: number | null,
  lineRange?: LineRange | null,
  animate?: boolean,        // false = apply this state instantly (no CSS transition); default true
  durationMs?: number,      // transition duration for this change (open vs commit)
  slideRange?: SlideRange | null,  // omitted = preserve current; null = clear; set = slide [from,to] by px
) => void
