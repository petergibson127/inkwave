// The export bundle (v4 spec §6, M4) — the self-contained, self-verifying record a writer hands to
// a verifier. It carries the content, the snapshots (with their OTS proofs + bundleHashes), the
// signed receipt chain, and the signing key reference. A third party verifies it with no Inkwave
// login (src/verify), against Bitcoin and the published key. Pure data assembly — no I/O here.

import type { InkwaveDocument, Snapshot, SignedReceipt, TiptapJSON } from '../types/document'
import { signingPublicKeyHex } from './receipts'
import { POOL_ID } from '../scas/pool'

export interface BundleSummary {
  what: string
  title: string
  words: number
  snapshots: number
  signedReceipts: number
  bitcoinAnchored: number
  created: string
  exported: string
  verifyAt: string
  note: string
}

export interface ExportBundle {
  v: 1
  summary?: BundleSummary // human-readable header (first key) — what the file is, at a glance
  exportedAt: string
  document: {
    id: string
    title: string
    contentJson: TiptapJSON
    createdAt: string
    schemaVersion: string
    scasMode?: string
    scasSetSize?: number
    scasPoolId?: string
  }
  snapshots: Snapshot[]       // each with contentJson, contentHash, bundleHash, ots proof, receipts
  receipts: SignedReceipt[]   // the live-composition signed chain (held by the writer)
  signingKey: { keyId: string; alg: 'Ed25519'; publicKeyHex: string }
  poolId: string
}

function countWords(contentJson: TiptapJSON): number {
  let text = ''
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const n = node as { text?: string; content?: unknown[] }
    if (typeof n.text === 'string') text += n.text + ' '
    if (Array.isArray(n.content)) n.content.forEach(walk)
  }
  walk(contentJson)
  const m = text.trim().match(/[\p{L}\p{N}]+/gu)
  return m ? m.length : 0
}

export function buildExportBundle(doc: InkwaveDocument, snapshots: Snapshot[]): ExportBundle {
  const receipts = doc.scasReceipts ?? []
  const exportedAt = new Date().toISOString()
  const summary: BundleSummary = {
    what: 'Inkwave provenance record — a tamper-evident, independently-verifiable record of how this document was written.',
    title: doc.title || 'Untitled',
    words: countWords(doc.contentJson),
    snapshots: snapshots.length,
    signedReceipts: receipts.length,
    bitcoinAnchored: snapshots.filter((s) => s.ots.status === 'confirmed').length,
    created: doc.createdAt,
    exported: exportedAt,
    verifyAt: 'https://inkwave.studio/verify',
    note: 'Open this file at the verify link above (or any Inkwave /verify page) to check it — entirely in your browser, against the published signing key and Bitcoin, with no sign-in. The fields below are the cryptographic record; this summary is for humans.',
  }
  return {
    v: 1,
    summary,
    exportedAt,
    document: {
      id: doc.id,
      title: doc.title,
      contentJson: doc.contentJson,
      createdAt: doc.createdAt,
      schemaVersion: doc.schemaVersion,
      scasMode: doc.scasMode,
      scasSetSize: doc.scasSetSize,
      scasPoolId: doc.scasPoolId,
    },
    snapshots,
    receipts,
    // A reference to the key the writer's client used; a verifier should still check against the
    // INDEPENDENTLY published key (src/verify defaults to it), not blindly trust this field.
    signingKey: { keyId: 'inkwave-signing-v1', alg: 'Ed25519', publicKeyHex: signingPublicKeyHex() },
    poolId: doc.scasPoolId ?? POOL_ID,
  }
}

/** Plain-text README written alongside the mirrored files (folder + OneDrive), for humans. */
export function bundleReadme(s?: BundleSummary): string {
  return [
    'Inkwave — your provenance record',
    '================================',
    '',
    'This folder mirrors your writing and its tamper-evident provenance record.',
    '',
    s ? `  Document : ${s.title}` : '',
    s ? `  Words    : ${s.words}` : '',
    s ? `  Snapshots: ${s.snapshots}   Signed receipts: ${s.signedReceipts}   Bitcoin-anchored: ${s.bitcoinAnchored}` : '',
    '',
    'Files:',
    '  inkwave-*.json     — the self-verifying export bundle. Open it at',
    '                       https://inkwave.studio/verify to check it (no sign-in).',
    '  *.current.json     — the document content (for reloading your work).',
    '  *.snapshots.json   — the dated snapshots with their Bitcoin proofs.',
    '',
    'You hold this record; Inkwave keeps nothing. Anyone can verify it against Inkwave’s',
    'published signing key and Bitcoin, with no Inkwave server in the loop.',
    '',
  ].filter((l) => l !== '').join('\n') + '\n'
}

export function bundleFilename(doc: InkwaveDocument): string {
  const slug = (doc.title || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'untitled'
  return `inkwave-${slug}.json`
}

/** Trigger a download of the bundle as pretty-printed JSON (browser only). */
export function downloadBundle(bundle: ExportBundle, filename: string): void {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
