// The SCAS controller — the seam between the live editor and the pure engine.
//
// It holds the per-session SCAS state (mirrored to doc.scasState for persistence), derives the
// current S_v, and on each document change scans the committed words to drive the state machine:
//   • a committed in-S lemma  → recordKick (turns purple, frozen)
//   • a completed substitution → resolve the ORIGINAL lemma (satisfied, or discharged if it was
//     locked) — inferred from the ScasSlotMark the popover writes, so no coupling to the popover
//   • a deleted kicked lemma   → lock (ban-credit) — inferred from a kicked lemma disappearing
// The editor wires onTransaction → processDoc, persists the new state, and forces a decoration
// rebuild; the RedHighlightExtension renders purely from the lookup this controller exposes.

import type { Node as PMNode } from '@tiptap/pm/model'
import type { ScasState } from '../types/document'
import {
  deriveSet,
  lemmaOf,
  classifyCommit,
  recordKick,
  markSatisfied,
  lock,
  discharge,
  resample,
  isLocked,
} from './engine'
import { buildLookup, type ScasLookup } from './state'

const WORD_RE = /[a-zA-Z]+/g
const BOUNDARY_RE = /[\s.,;:!?)\-'"…]/

interface ScannedWord {
  lemma: string
  slotOriginalLemma: string | null
  isSubstitution: boolean // carries a slot mark whose current lemma differs from its original
}

/**
 * Collect the document's *committed* words. A word is committed unless it is the one under the
 * cursor still being typed (no trailing boundary yet) — matching the renderer's definition, so a
 * kick fires exactly when the word turns red.
 */
function scanCommitted(pmDoc: PMNode, cursorPos: number): ScannedWord[] {
  const out: ScannedWord[] = []
  pmDoc.descendants((node: PMNode, pos: number) => {
    if (node.type.name !== 'paragraph') return true
    node.forEach((child: PMNode, offset: number) => {
      if (!child.isText || !child.text) return
      const text = child.text
      const slotMark = child.marks.find((m) => m.type.name === 'scasSlot')
      const slotOriginal = (slotMark?.attrs.original as string | null) ?? null
      let match: RegExpExecArray | null
      WORD_RE.lastIndex = 0
      while ((match = WORD_RE.exec(text)) !== null) {
        const word = match[0]
        if (word.length < 2) continue
        const from = pos + 1 + offset + match.index
        const to = from + word.length
        // Skip the uncommitted word under the cursor (no boundary char right after it yet).
        if (cursorPos >= from && cursorPos <= to) {
          const nextChar = text[match.index + word.length] ?? null
          if (!nextChar || !BOUNDARY_RE.test(nextChar)) continue
        }
        const lemma = lemmaOf(word)
        const slotOriginalLemma = slotOriginal ? lemmaOf(slotOriginal) : null
        out.push({
          lemma,
          slotOriginalLemma,
          isSubstitution: slotOriginalLemma !== null && slotOriginalLemma !== lemma,
        })
      }
    })
    return false
  })
  return out
}

export class ScasController {
  state: ScasState
  private seedRef: string
  private docId: string
  private setSize: number
  private currentSet: Set<string>

  constructor(state: ScasState, seedRef: string, docId: string, setSize: number) {
    this.state = state
    this.seedRef = seedRef
    this.docId = docId
    this.setSize = setSize
    this.currentSet = deriveSet(seedRef, docId, state.version, setSize)
  }

  /** Point the controller at a (possibly different) active document + state. */
  reseat(state: ScasState, seedRef: string, docId: string, setSize: number): void {
    this.state = state
    this.seedRef = seedRef
    this.docId = docId
    this.setSize = setSize
    this.currentSet = deriveSet(seedRef, docId, state.version, setSize)
  }

  inSv(lemma: string): boolean {
    return this.currentSet.has(lemma)
  }

  lookup(): ScasLookup {
    return buildLookup(this.state)
  }

  /**
   * Process a document change: fire kicks, resolve substitutions, and (only when content was
   * removed) lock deleted kicked lemmas. Returns true if the state changed.
   */
  processDoc(pmDoc: PMNode, cursorPos: number, hadDeletion: boolean): boolean {
    const words = scanCommitted(pmDoc, cursorPos)
    const before = this.state
    let st = this.state

    // 1. Resolutions — a completed substitution resolves the ORIGINAL lemma.
    for (const w of words) {
      if (w.isSubstitution && w.slotOriginalLemma) {
        const o = w.slotOriginalLemma
        st = isLocked(st, o) ? discharge(st, o) : markSatisfied(st, o)
      }
    }

    // 2. Fresh kicks — a committed in-S lemma (not immune/locked) becomes an outstanding kick.
    for (const w of words) {
      const v = classifyCommit(st, w.lemma, this.inSv(w.lemma))
      if (v.kicks && v.trigger === 'in-S') st = recordKick(st, w.lemma)
    }

    // 3. Deletions — a kicked lemma that vanished (and wasn't resolved via a slot) is a dodge → lock.
    //    Gated on an actual deletion so merely-not-yet-committed words aren't mistaken for deletes.
    if (hadDeletion) {
      const present = new Set(words.map((w) => w.lemma))
      const slotRefs = new Set(words.map((w) => w.slotOriginalLemma).filter(Boolean) as string[])
      for (const L of before.liveKicks) {
        if (!present.has(L) && !slotRefs.has(L)) st = lock(st, L)
      }
    }

    this.state = st
    return st !== before
  }

  /** Advance to the next S-version (a resample): re-derive S_v and expire stale immunity. */
  resampleNow(): boolean {
    const nextVersion = this.state.version + 1
    this.state = resample(this.state, nextVersion)
    this.currentSet = deriveSet(this.seedRef, this.docId, nextVersion, this.setSize)
    return true
  }
}
