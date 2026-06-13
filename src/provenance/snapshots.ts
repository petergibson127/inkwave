// Snapshot storage (v4 spec §8, M1). A snapshot is a content-addressed, append-only record of the
// document at a moment: its contentHash, the Bitcoin-anchored bundleHash, and an OTS proof slot
// (unstamped until M2). Snapshots are taken on a *resolved kick* when the content hash has changed
// — so ordinary typing and pasted blocks (no kick resolution) never produce one.
//
// Stored in OPFS alongside the document: documents/<id>/snapshots.json (an array, append-only).
// The folder-mirror to a writer-granted directory arrives in M4.

import { v4 as uuidv4 } from 'uuid'
import type { InkwaveDocument, Snapshot, SignedReceipt, TiptapJSON } from '../types/document'
import { contentHash, bundleHash } from './hash'
import { stampBundle, upgradeProof } from './ots'

async function getRoot(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory()
}

async function readSnapshotsFile(documentId: string): Promise<Snapshot[]> {
  try {
    const root = await getRoot()
    let dir: FileSystemDirectoryHandle = root
    for (const part of `documents/${documentId}`.split('/')) {
      dir = await dir.getDirectoryHandle(part)
    }
    const file = await (await dir.getFileHandle('snapshots.json')).getFile()
    const parsed = JSON.parse(await file.text())
    return Array.isArray(parsed) ? (parsed as Snapshot[]) : []
  } catch {
    return []
  }
}

async function writeSnapshotsFile(documentId: string, snaps: Snapshot[]): Promise<void> {
  const root = await getRoot()
  let dir: FileSystemDirectoryHandle = root
  for (const part of `documents/${documentId}`.split('/')) {
    dir = await dir.getDirectoryHandle(part, { create: true })
  }
  const handle = await dir.getFileHandle('snapshots.json', { create: true })
  const writable = await handle.createWritable()
  await writable.write(JSON.stringify(snaps))
  await writable.close()
}

/** All snapshots for a document, in creation order. */
export async function listSnapshots(documentId: string): Promise<Snapshot[]> {
  return readSnapshotsFile(documentId)
}

export async function latestSnapshot(documentId: string): Promise<Snapshot | null> {
  const snaps = await readSnapshotsFile(documentId)
  return snaps.length ? snaps[snaps.length - 1] : null
}

/** Count content words in TipTap JSON (whitespace-delimited runs of letters/digits). */
export function countWords(contentJson: TiptapJSON): number {
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

/**
 * Take a snapshot IF the content has changed since the last one. Returns the new Snapshot, or null
 * if the content hash is unchanged (so repeated triggers on the same text don't pile up). Offline,
 * no network — OTS stamping (M2) and receipts (M3) layer on later.
 */
export async function createSnapshotIfChanged(
  doc: InkwaveDocument,
  trigger: Snapshot['trigger'],
  receipts: SignedReceipt[] = [],
): Promise<Snapshot | null> {
  const cHash = await contentHash(doc.contentJson)
  const snaps = await readSnapshotsFile(doc.id)
  const last = snaps[snaps.length - 1]
  if (last && last.contentHash === cHash) return null

  // bundleHash commits to content AND the live-composition receipt chain, so the OTS proof (M2)
  // anchors the whole signed record to Bitcoin.
  const snapshot: Snapshot = {
    id: uuidv4(),
    documentId: doc.id,
    createdAt: new Date().toISOString(),
    trigger,
    wordCount: countWords(doc.contentJson),
    contentHash: cHash,
    contentJson: doc.contentJson,
    receipts,
    bundleHash: await bundleHash(cHash, receipts),
    ots: { status: 'unstamped' },
  }
  await writeSnapshotsFile(doc.id, [...snaps, snapshot])
  return snapshot
}

// ─── OTS stamping / upgrading (M2) ──────────────────────────────────────────────
// Each mutation re-reads the file before writing, so callers that serialise them (the editor's
// snapshot queue) never lose a concurrent append.

async function patchSnapshot(
  documentId: string,
  id: string,
  ots: Snapshot['ots'],
): Promise<Snapshot | null> {
  const snaps = await readSnapshotsFile(documentId)
  const i = snaps.findIndex((s) => s.id === id)
  if (i < 0) return null
  snaps[i] = { ...snaps[i], ots }
  await writeSnapshotsFile(documentId, snaps)
  return snaps[i]
}

/** Stamp one unstamped snapshot's bundleHash → pending. Returns the updated snapshot, or null. */
export async function stampSnapshot(documentId: string, id: string): Promise<Snapshot | null> {
  const snaps = await readSnapshotsFile(documentId)
  const snap = snaps.find((s) => s.id === id)
  if (!snap || snap.ots.status !== 'unstamped') return null
  const ots = await stampBundle(snap.bundleHash)
  if (!ots) return null // relay unreachable — stay unstamped, retry on next drain
  return patchSnapshot(documentId, id, ots)
}

/** Stamp every still-unstamped snapshot (drains the backlog on reconnect). */
export async function drainUnstamped(documentId: string): Promise<void> {
  const snaps = await readSnapshotsFile(documentId)
  for (const s of snaps) {
    if (s.ots.status === 'unstamped') {
      try { await stampSnapshot(documentId, s.id) } catch { /* stay unstamped; retry later */ }
    }
  }
}

/** Ask the calendars to upgrade every pending proof; promotes to 'confirmed' once Bitcoin has it. */
export async function upgradePending(documentId: string): Promise<void> {
  const snaps = await readSnapshotsFile(documentId)
  for (const s of snaps) {
    if (s.ots.status === 'pending' && s.ots.proofBase64) {
      try {
        const ots = await upgradeProof(s.ots.proofBase64, s.bundleHash)
        if (ots) await patchSnapshot(documentId, s.id, ots)
      } catch { /* not ready / offline */ }
    }
  }
}
