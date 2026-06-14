// OpenTimestamps core, run in Node (the serverless function + the dev middleware share it).
// javascript-opentimestamps is a Node library (global Buffer, node crypto/fs) — keeping it here
// avoids browser-bundling it, which fights the SPA's SSR/prerender. This relay is the v4 spec's
// sanctioned `api/stamp` fallback: it logs NOTHING and only submits/queries a hash, so the
// existence proof stays independently Bitcoin-verifiable with no Inkwave server in the verify loop.

import OpenTimestamps from 'javascript-opentimestamps/index.js'

const { DetachedTimestampFile, Ops } = OpenTimestamps

function detachedForBundle(bundleHashHex) {
  return DetachedTimestampFile.fromHash(new Ops.OpSHA256(), Buffer.from(bundleHashHex, 'hex'))
}

/** Submit a bundleHash to the calendars → a complete PENDING proof (base64). */
export async function otsStamp(bundleHashHex) {
  const detached = detachedForBundle(bundleHashHex)
  await OpenTimestamps.stamp(detached)
  return { status: 'pending', proofBase64: Buffer.from(detached.serializeToBytes()).toString('base64') }
}

/** Upgrade a pending proof; promote to 'confirmed' (with block height + time) once Bitcoin has it. */
export async function otsUpgrade(proofBase64, bundleHashHex) {
  let detached
  try {
    detached = DetachedTimestampFile.deserialize([...Buffer.from(proofBase64, 'base64')])
  } catch {
    return { status: 'pending', proofBase64 }
  }
  try { await OpenTimestamps.upgrade(detached) } catch { /* offline / not ready */ }
  const upgraded = Buffer.from(detached.serializeToBytes()).toString('base64')

  try {
    const original = detachedForBundle(bundleHashHex)
    const result = await OpenTimestamps.verify(detached, original)
    if (result) {
      const btc =
        result.bitcoin ?? result.Bitcoin ??
        Object.values(result).find((v) => v && (v.height || v.timestamp))
      // Only claim 'confirmed' with GENUINE values — never fabricate block 0 / epoch time via `?? 0`.
      // These fields are now only a hint anyway: the open verifier re-derives block height + time from
      // the proof bytes against independent explorers and ignores any claim it can't reproduce.
      if (btc && Number.isFinite(btc.height) && Number.isFinite(btc.timestamp) && btc.height > 0 && btc.timestamp > 0) {
        return {
          status: 'confirmed',
          proofBase64: upgraded,
          bitcoinBlock: btc.height,
          bitcoinTime: new Date(btc.timestamp * 1000).toISOString(),
        }
      }
    }
  } catch { /* not yet confirmed */ }

  return { status: 'pending', proofBase64: upgraded }
}

/** Dispatch a parsed request body to the right action. Shared by the function + dev middleware. */
export async function handleOts(body) {
  if (body?.action === 'stamp' && typeof body.bundleHash === 'string') {
    return otsStamp(body.bundleHash)
  }
  if (body?.action === 'upgrade' && typeof body.proofBase64 === 'string' && typeof body.bundleHash === 'string') {
    return otsUpgrade(body.proofBase64, body.bundleHash)
  }
  throw new Error('bad request')
}
