import React from 'react'
import { CYCLE_SIZE, DELETE_SENTINEL, CARD_PAD_X } from './popoverConstants'
import { measureTextWidth } from '../textMetrics'

// Renders ⌫ in system-ui (IM Fell DW Pica doesn't have this glyph), otherwise returns s.
export function displayFor(s: string, mobileScale = 1): React.ReactNode {
  if (s !== DELETE_SENTINEL) return s
  const fontSize = mobileScale > 1 ? `${mobileScale}em` : '0.82em'
  const style: React.CSSProperties = { fontFamily: 'system-ui, sans-serif', fontSize }
  if (mobileScale > 1) style.lineHeight = '1'
  return <span style={style}>⌫</span>
}

// Capitalises the first letter, leaving the rest untouched ("use" → "Use").
export function capitalizeFirst(w: string): string {
  return w ? w.charAt(0).toUpperCase() + w.slice(1) : w
}

// Fills all CYCLE_SIZE slots from [original, ...synonyms], cycling if short.
// No delete slot — deletion is done by double-clicking the word in the editor.
// When `capitalize` is set every slot gets a capital first letter, so a flagged word
// written with a leading capital keeps it through the whole reel (and on commit).
// Returns the slot array and the card min-width (widest synonym + horizontal padding).
export function buildSynonyms(
  displayWord: string, candidates: string[], font: string, wordWidth: number,
  capitalize = false,
): { synonyms: string[]; minWidth: number } {
  const cap      = capitalize ? capitalizeFirst : (w: string) => w
  const pool     = [displayWord, ...candidates].map(cap)
  const synonyms = Array.from({ length: CYCLE_SIZE }, (_, i) => pool[i % pool.length])
  const minWidth = Math.max(
    wordWidth,
    ...synonyms.map(s => measureTextWidth(s, font)),
  ) + CARD_PAD_X * 2
  return { synonyms, minWidth }
}
