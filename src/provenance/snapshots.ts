// Snapshot storage (v4 spec §8, M1). A snapshot is a content-addressed, append-only record of the
// document at a moment: its contentHash, the Bitcoin-anchored bundleHash, and an OTS proof slot
// (unstamped until M2). Snapshots are taken on a *resolved kick* when the content hash has changed
// — so ordinary typing and pasted blocks (no kick resolution) never produce one.
//
// Stored in OPFS alongside the document: documents/<id>/snapshots.json (an array, append-only).
// The folder-mirror to a writer-granted directory arrives in M4.

import { v4 as uuidv4 } from 'uuid'
import type { InkwaveDocument, Snapshot, TiptapJSON } from '../types/document'
import { contentHash, bundleHash } from './hash'

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
): Promise<Snapshot | null> {
  const cHash = await contentHash(doc.contentJson)
  const snaps = await readSnapshotsFile(doc.id)
  const last = snaps[snaps.length - 1]
  if (last && last.contentHash === cHash) return null

  const snapshot: Snapshot = {
    id: uuidv4(),
    documentId: doc.id,
    createdAt: new Date().toISOString(),
    trigger,
    wordCount: countWords(doc.contentJson),
    contentHash: cHash,
    contentJson: doc.contentJson,
    receipts: [],
    bundleHash: await bundleHash(cHash, []),
    ots: { status: 'unstamped' },
  }
  await writeSnapshotsFile(doc.id, [...snaps, snapshot])
  return snapshot
}
