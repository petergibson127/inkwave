// Vercel serverless function: sign a completed period's receipt and issue the next set (the §8
// one-round-trip flow). POST { sessionToken, docId, counter, prevHash, contentHash, setVersion,
// kicksHash, cadenceDigest? } → { serverTime, signature, lockedSet, lockedSetHash, next }.
// Receives only hashes — never content, the raw set, or kick text. Stateless; logs nothing.

import { handleSign } from './_provenance-core.mjs'

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.statusCode = 405; return res.end('Method Not Allowed') }
  try {
    const body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}')
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(await handleSign(body, req.headers?.authorization)))
  } catch (err) {
    const m = err?.message
    res.statusCode = m === 'bad request' ? 400 : m === 'invalid session' ? 401 : m === 'subscription required' ? 402 : 500
    res.end(JSON.stringify({ error: m === 'subscription required' ? 'subscription required' : m === 'invalid session' ? 'invalid session' : 'sign failed' }))
  }
}
