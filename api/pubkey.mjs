// Returns the signing service's ACTUAL public key (derived from the configured INKWAVE_SIGNING_SK,
// or the dev placeholder if unset). This is the source of truth for what to verify against, so the
// published key can never drift from the key that actually signs. Safe to expose — it's public.

import { publicKeyHex } from './_provenance-core.mjs'

export default async function handler(_req, res) {
  res.setHeader('content-type', 'application/json')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify({ alg: 'Ed25519', keyId: 'inkwave-signing-v1', publicKeyHex: await publicKeyHex() }))
}
