import { Verify } from '../../src/routes/Verify'

export function meta() {
  return [
    { title: 'Verify an Inkwave record' },
    {
      name: 'description',
      content:
        'Open, client-side verification of an Inkwave provenance record — checked against the published signing key and Bitcoin, with no sign-in.',
    },
  ]
}

export default function VerifyRoute() {
  return <Verify />
}
