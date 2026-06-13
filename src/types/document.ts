// ─── Core JSON shape for ProseMirror / Tiptap content ────────────────────────
// Re-export Tiptap's own JSONContent so the rest of the codebase uses one type.

import type { JSONContent } from '@tiptap/react'
export type TiptapJSON = JSONContent

// ─── Schema versioning ────────────────────────────────────────────────────────

export type SchemaVersion = '0.1.0'

// ─── Primary document model ───────────────────────────────────────────────────
// Typography (font / size / alignment) is stored per-selection as ProseMirror marks
// inside contentJson, so it persists with the content — no separate field needed.

export interface InkwaveDocument {
  id: string
  title: string
  contentJson: TiptapJSON          // ProseMirror JSON for editor content
  createdAt: string                // ISO 8601
  updatedAt: string                // ISO 8601
  schemaVersion: SchemaVersion
  scasLimitN: number | 'infinite'  // active SCAS vocabulary cap (Week 2 — old per-paragraph model)
  scasSessionSeed: string          // deterministic-per-document ranking seed (Week 2)

  // ─── SCAS v2 / provenance spine (M0+) ──────────────────────────────────────
  // The engine (src/scas/engine.ts + state.ts) supersedes the Week-2 per-paragraph
  // rank-perturbation model. These are optional so pre-M0 documents still load;
  // src/routes/Edit.tsx fills defaults on open (see migrateDocument).
  scasMode?: ScasMode              // v0.1: 'n' (N-mode) only
  scasSetSize?: number             // |S| — fixed exclusion-set size in N-mode (e.g. 300)
  scasSeedRef?: string             // M0: a local seed (stand-in); M3: opaque server ref. The seed
                                   // itself never reaches the client once the signing service exists.
  scasPoolId?: string              // id + hash of the public pool P (reproducibility)
  scasState?: ScasState            // the ban-credit / satisfied / version overlay (persisted)
  scasReceipts?: SignedReceipt[]   // the live-composition signed receipt chain for this doc (M3)
}

// ─── SCAS engine state (M0) ───────────────────────────────────────────────────
// The client-side overlay on top of S_v membership: which lemmas are Locked (ban-credit
// outstanding) and which are Satisfied (immune until the next resample). `S_v` itself is a
// pure function of the seed and is NOT stored here. The verifier replays this overlay from
// the logged kick events; it is never folded into the seed derivation. See v4 spec §4.3/§8.

export type ScasMode = 'n'

export interface SatisfiedEntry {
  lemma: string
  satisfiedAtVersion: number       // immune while this === ScasState.version
}

export interface ScasState {
  version: number                  // current S-version v
  locked: string[]                 // ban-credit set B (lemmas) — state "Locked"
  satisfied: SatisfiedEntry[]      // resolved-in-place lemmas, immune for their version
  liveKicks: string[]              // outstanding, unresolved in-S kicks (lemmas). Frozen at commit
                                   // so the word stays purple across S-rotation and reload without
                                   // recomputing membership; cleared when resolved (swap/dismiss) or
                                   // moved to `locked` on delete. Locked lemmas colour via `locked`.
}

// ─── Paragraph metadata ───────────────────────────────────────────────────────
// Stored as attributes on paragraph nodes via ParagraphGlyphExtension (Week 4).

export interface ParagraphMetadata {
  glyph: string        // e.g. "ibis"
  glyphIconRef: string // e.g. "🦤" or "/icons/ibis.svg"
  createdAt: string    // ISO 8601

  // Phase 1.5+ — DO NOT implement in v0.1:
  // keywords?: string[]
  // commitmentState?: 'wet-clay' | 'fired-clay' | 'stone'
  // superheatedSentences?: SentenceCommitment[]
}

// ─── Snapshots & receipts (provenance spine — M1+) ────────────────────────────
// v4 spec §8. Everything hashed/signed is byte-reproducible by an independent verifier:
// canonicalise with RFC 8785 (JCS), hashes are lowercase-hex SHA-256, signatures/proofs base64.

export interface Snapshot {
  id: string
  documentId: string
  createdAt: string                 // writer's local clock — ordering only, never authority
  trigger: 'kick' | 'manual'
  wordCount: number
  contentHash: string               // sha256Hex(JCS(contentJson))
  contentJson: TiptapJSON           // held by the writer; never transmitted
  receipts?: SignedReceipt[]        // the live-composition (+cadence) chain for this span (M3)
  bundleHash: string                // sha256Hex(JCS({ v:1, contentHash, receipts: receipts ?? [] }))
  ots: OtsProofState                // OTS over bundleHash → Bitcoin (M2)
}

export interface OtsProofState {
  status: 'unstamped' | 'pending' | 'confirmed'
  proofBase64?: string
  bitcoinBlock?: number
  bitcoinTime?: string              // block time — the durable authoritative timestamp
}

// One kick (constraint encounter) and how it was resolved — the no-silent-dodging evidence.
export interface KickEvent {
  lemma: string
  commitIndex: number               // order within the document (for state-machine replay)
  setVersion: number
  trigger: 'in-S' | 'locked'
  response: 'swapped' | 'justified' | 'dismissed' | 'deleted->credit' | 'credit-discharged'
  replacement?: string              // lemma swapped to (response 'swapped' / 'credit-discharged')
  deliberationMs: number            // selectable → resolved
}

// One per signing period, hash-chained into one fixed sequence per session (M3). Defined now so
// the Snapshot/bundle types are complete; the signing service that populates it arrives in M3.
export interface SignedReceipt {
  v: 1
  sessionToken: string
  counter: number
  prevHash: string
  contentHash: string
  setVersion: number
  lockedSetHash: string
  kicks: KickEvent[]
  serverTime: string
  cadenceDigest?: string
  signature: string
  // held by the writer, NOT sent to the server:
  lockedSet: string                 // base64 bitmask over P (the period's S_v)
  cadence?: KeylogBin[]             // paid only: 0.5s insert/delete COUNTS — never characters
}

export interface KeylogBin { ins: number; del: number }

// ─── Provenance events ────────────────────────────────────────────────────────

export type ProvenanceEventType =
  | 'session-start'
  | 'session-end'
  | 'snapshot-created'
  | 'snapshot-restored'
  | 'suggestion-accepted'
  | 'suggestion-ignored'
  | 'paste-event'
  | 'limit-changed'
  | 'paragraph-glyph-assigned'
  | 'paragraph-glyph-overridden'

export interface ProvenanceEvent {
  id: string
  documentId: string
  type: ProvenanceEventType
  timestamp: string              // ISO 8601
  payload: Record<string, unknown>
}

// ─── IndexedDB metadata row (lightweight, for fast listing) ───────────────────

export interface DocumentMeta {
  id: string
  title: string
  updatedAt: string
}
