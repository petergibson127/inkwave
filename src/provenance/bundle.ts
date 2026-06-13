// The export bundle (v4 spec §6, M4) — the self-contained, self-verifying record a writer hands to
// a verifier. It carries the content, the snapshots (with their OTS proofs + bundleHashes), the
// signed receipt chain, and the signing key reference. A third party verifies it with no Inkwave
// login (src/verify), against Bitcoin and the published key. Pure data assembly — no I/O here.

import type { InkwaveDocument, Snapshot, SignedReceipt, TiptapJSON } from '../types/document'
import { signingPublicKeyHex } from './receipts'
import { POOL_ID } from '../scas/pool'

export interface ExportBundle {
  v: 1
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

export function buildExportBundle(doc: InkwaveDocument, snapshots: Snapshot[]): ExportBundle {
  return {
    v: 1,
    exportedAt: new Date().toISOString(),
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
    receipts: doc.scasReceipts ?? [],
    // A reference to the key the writer's client used; a verifier should still check against the
    // INDEPENDENTLY published key (src/verify defaults to it), not blindly trust this field.
    signingKey: { keyId: 'inkwave-signing-v1', alg: 'Ed25519', publicKeyHex: signingPublicKeyHex() },
    poolId: doc.scasPoolId ?? POOL_ID,
  }
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
