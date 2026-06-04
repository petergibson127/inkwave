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

// Fills all CYCLE_SIZE slots from [original, ...synonyms], cycling if short.
// No delete slot — deletion is done by double-clicking the word in the editor.
// Returns the slot array and the card min-width (widest synonym + horizontal padding).
export function buildSynonyms(
  displayWord: string, candidates: string[], font: string, wordWidth: number,
): { synonyms: string[]; minWidth: number } {
  const pool     = [displayWord, ...candidates]
  const synonyms = Array.from({ length: CYCLE_SIZE }, (_, i) => pool[i % pool.length])
  const minWidth = Math.max(
    wordWidth,
    ...synonyms.map(s => measureTextWidth(s, font)),
  ) + CARD_PAD_X * 2
  return { synonyms, minWidth }
}
