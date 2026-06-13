// Vercel serverless function: open an anonymous live-composition session (free, account-free).
// POST { docId } → { sessionToken, setVersion:0, lockedSet, lockedSetHash }. Stateless; logs
// nothing. (Anti-abuse — per-IP limit / small PoW — is a later hardening pass.)

import { handleSession } from './_provenance-core.mjs'

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.statusCode = 405; return res.end('Method Not Allowed') }
  try {
    const body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}')
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(await handleSession(body)))
  } catch (err) {
    res.statusCode = err?.message === 'bad request' ? 400 : 500
    res.end(JSON.stringify({ error: 'session failed' }))
  }
}
