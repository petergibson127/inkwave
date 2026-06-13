// The export bundle (v4 spec §6, M4) — the self-contained, self-verifying record a writer hands to
// a verifier. It carries the content, the snapshots (with their OTS proofs + bundleHashes), the
// signed receipt chain, and the signing key reference. A third party verifies it with no Inkwave
// login (src/verify), against Bitcoin and the published key. Pure data assembly — no I/O here.

import type { InkwaveDocument, Snapshot, SignedReceipt, TiptapJSON } from '../types/document'
import { signingPublicKeyHex } from './receipts'
import { POOL_ID } from '../scas/pool'
import { deviceId } from '../sync/presence'

// A clean, readable plain-text copy of the document — block nodes (paragraphs/headings/list items)
// separated by blank lines, hard breaks as newlines. Sits near the top of the bundle so the writing
// is legible to a human opening the file, with no markdown syntax to parse.
export function pmToText(doc: TiptapJSON): string {
  const blocks: string[] = []
  const inline = (node: { type?: string; text?: string; content?: unknown[] }): string => {
    if (node.type === 'text') return node.text ?? ''
    if (node.type === 'hardBreak') return '\n'
    return (node.content as typeof node[] ?? []).map(inline).join('')
  }
  const walk = (node: { type?: string; text?: string; content?: unknown[] }): void => {
    const t = node.type
    if (t === 'paragraph' || t === 'heading' || t === 'listItem' || t === 'blockquote' || t === 'codeBlock') {
      blocks.push((node.content as typeof node[] ?? []).map(inline).join('').trim())
    } else if (Array.isArray(node.content)) {
      ;(node.content as typeof node[]).forEach(walk)
    }
  }
  walk(doc as { type?: string; content?: unknown[] })
  return blocks.filter((b) => b.length > 0).join('\n\n') + '\n'
}

// Hard-wrap each paragraph at ~width columns on word boundaries. The readable header is plain text
// (real line + paragraph breaks), so it stays legible in any viewer — unlike a JSON string value,
// whose newlines show as escaped "\n" on one long line.
function wrapText(text: string, width = 76): string {
  return text.split('\n').map((line) => {
    if (line.length <= width) return line
    const out: string[] = []
    let cur = ''
    for (const word of line.split(' ')) {
      if (cur && (cur + ' ' + word).length > width) { out.push(cur); cur = word }
      else cur = cur ? `${cur} ${word}` : word
    }
    if (cur) out.push(cur)
    return out.join('\n')
  }).join('\n')
}

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
  text?: string           // a clean, readable plain-text copy of the writing, near the top
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
  session?: string // writing device id (advisory multi-device guard; not part of any hash)
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
    text: pmToText(doc.contentJson),
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
    session: deviceId(),
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

function slugOf(doc: InkwaveDocument): string {
  return (doc.title || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'untitled'
}

// Everything (content, snapshots, Bitcoin proofs, signed receipts, readable text header) lives in
// ONE file. Free tier → `.trace.json`; the paid "Insignia" tier will use `.insig.json` (auth TBD).
export const TRACE_EXTENSION = 'trace.json'

export function bundleFilename(doc: InkwaveDocument): string {
  return `${slugOf(doc)}.${TRACE_EXTENSION}`
}

// The .trace.json file is a hybrid: the WRITING first (wrapped — real line + paragraph breaks, so
// you open the file and read it immediately), then this marker, then the verifiable JSON record.
// composeTraceFile() writes that shape; parseTraceFile() reads it back (and still accepts a legacy
// pure-JSON file). The box-drawing rule makes the marker unmistakable and ~impossible to hit in prose.
const TRACE_DATA_MARKER = '══════ INKWAVE RECORD · verify at inkwave.studio/verify ══════'

/** Serialize a bundle to the single .trace.json file: readable writing on top, JSON record below. */
export function composeTraceFile(bundle: ExportBundle): string {
  return [
    wrapText((bundle.text ?? '').replace(/\n+$/, '')),
    '',
    '══════════════════════════════════════════════════════════════',
    TRACE_DATA_MARKER,
    'Everything below is the structured record that proves the writing above. You don’t need to',
    'read it — open this file at inkwave.studio/verify to check it.',
    '══════════════════════════════════════════════════════════════',
    '',
    JSON.stringify(bundle, null, 2),
    '',
  ].join('\n')
}

/** Read a .trace.json file back into a bundle (hybrid text-header format OR a legacy pure-JSON file). */
export function parseTraceFile(fileText: string): ExportBundle {
  const i = fileText.indexOf('INKWAVE RECORD · verify')
  const json = i < 0 ? fileText : fileText.slice(fileText.indexOf('{', i))
  return JSON.parse(json) as ExportBundle
}

/** Trigger a download of the single self-contained .trace.json file (browser only). */
export function downloadBundle(bundle: ExportBundle, filename: string): void {
  const blob = new Blob([composeTraceFile(bundle)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
