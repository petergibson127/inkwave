import type { Config } from '@react-router/dev/config'

export default {
  appDirectory: 'app',
  // SPA mode: no runtime server. Routes listed in `prerender` are rendered to static
  // HTML at build time (SEO + instant first paint). Flip `ssr: true` later when the
  // Phase-2 "rooms" model needs per-request server rendering (e.g. /r/:id share previews).
  ssr: false,
  async prerender() {
    return ['/', '/about', '/verify']
  },
} satisfies Config
