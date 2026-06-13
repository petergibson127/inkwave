import { Edit } from '../../src/routes/Edit'

export function meta() {
  return [
    { title: 'Inkwave: a calm place to write' },
    {
      name: 'description',
      content:
        'Inkwave Scroll is a calm, low-friction writing surface for short academic and philosophical writing. Open it and begin — no sign-up, no dashboard.',
    },
    { property: 'og:title', content: 'Inkwave' },
    { property: 'og:description', content: 'A calm, low-friction writing surface. Open it and begin.' },
    { property: 'og:type', content: 'website' },
  ]
}

// The editor is the landing page. It renders a prerendered empty-editor shell (static HTML,
// styled by the same CSS as the live editor), then mounts the real Tiptap editor client-side.
export default function Home() {
  return <Edit />
}
