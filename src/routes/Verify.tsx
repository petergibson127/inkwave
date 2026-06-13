import { useState } from 'react'
import { Link } from 'react-router'
import { verifyBundle, type VerifyReport } from '../verify'
import { signingPublicKeyHex } from '../provenance/receipts'
import type { ExportBundle } from '../provenance/bundle'

const INK = '#5c2d8a'
const LIGHT = '#9b5ccc'

// Open verification page (M5). Drop in an Inkwave export bundle; everything runs in YOUR browser
// against the published signing key — no Inkwave login, nothing sent anywhere.
export function Verify() {
  const [report, setReport] = useState<VerifyReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [title, setTitle] = useState<string | null>(null)

  async function run(text: string) {
    setError(null); setReport(null); setTitle(null); setBusy(true)
    try {
      const bundle = JSON.parse(text) as ExportBundle
      if (bundle.v !== 1 || !Array.isArray(bundle.receipts) || !Array.isArray(bundle.snapshots)) {
        throw new Error('not an Inkwave export bundle')
      }
      setTitle(bundle.document?.title ?? null)
      // Verify against the published key (dev uses the dev placeholder, matching dev-signed bundles).
      setReport(await verifyBundle(bundle, signingPublicKeyHex()))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    file.text().then(run)
  }

  return (
    <div className="min-h-screen flex flex-col items-center px-4 py-10 font-serif" style={{ color: '#3a3a3a' }}>
      <div className="w-full max-w-xl">
        <h1 className="text-2xl mb-1" style={{ color: INK }}>Verify an Inkwave record</h1>
        <p className="text-sm text-stone-500 mb-5">
          Runs entirely in your browser, against Inkwave's published signing key and Bitcoin —
          no sign-in, nothing uploaded. <Link to="/" className="underline" style={{ color: LIGHT }}>← editor</Link>
        </p>

        <label
          className="block border-2 border-dashed rounded-xl px-4 py-8 text-center cursor-pointer hover:bg-stone-50"
          style={{ borderColor: `${INK}55` }}
        >
          <input type="file" accept="application/json,.json" className="hidden" onChange={onFile} />
          <span style={{ color: INK }}>Choose an export bundle</span>
          <span className="block text-xs text-stone-400 mt-1">a .json file from the editor's “export bundle”</span>
        </label>

        {busy && <p className="mt-4 text-stone-500">Verifying…</p>}
        {error && <p className="mt-4 text-red-700">⚠ {error}</p>}

        {report && (
          <div className="mt-6">
            <div
              className="rounded-xl px-4 py-3 mb-4 text-lg"
              style={{ border: `1px solid ${INK}`, background: report.overall ? '#f3fbf3' : '#fdf3f3', color: report.overall ? '#246b24' : '#9b2226' }}
            >
              {report.overall ? '✓ Authentic Inkwave record' : '✗ Verification failed'}
              {title ? <span className="text-sm text-stone-500"> — “{title}”</span> : null}
            </div>

            <Row label="Content integrity" ok={report.contentIntegrity.ok}
                 detail={report.contentIntegrity.ok ? `${report.contentIntegrity.checked} snapshot(s) intact` : report.contentIntegrity.reason} />
            <Row label="Signed chain" ok={report.chain.ok}
                 detail={report.chain.ok ? `${report.chain.verified} receipt(s) across ${report.chain.sessions} session(s) verify` : report.chain.reason} />
            <Row label="Kick consistency" ok={report.kickConsistency.ok}
                 detail={report.kickConsistency.ok ? `${report.kickConsistency.checked} kick(s) match the signed sets` : report.kickConsistency.reason} />
            <Row label="Friction" detail={report.friction.note} />
            <Row label="Bitcoin anchoring"
                 detail={`${report.existence.confirmed} confirmed · ${report.existence.pending} pending · ${report.existence.unstamped} local (of ${report.existence.snapshots})`} />

            <p className="mt-4 text-xs text-stone-400">
              This confirms an authentic Inkwave session composed live against unpredictable
              constraints, tamper-evident and signed — not that a human wrote every word.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function Row({ label, ok, detail }: { label: string; ok?: boolean; detail?: string }) {
  return (
    <div className="flex items-baseline gap-3 py-1.5 border-b" style={{ borderColor: '#eee' }}>
      <span className="w-5">{ok === undefined ? '·' : ok ? '✓' : '✗'}</span>
      <span className="w-40" style={{ color: INK }}>{label}</span>
      <span className="text-sm text-stone-500 flex-1">{detail}</span>
    </div>
  )
}
