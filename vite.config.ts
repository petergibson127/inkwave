import { reactRouter } from '@react-router/dev/vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig, type PluginOption } from 'vite'

// The /api/* serverless functions (OTS relay, signing service) are Node-only and don't bundle into
// the browser/SSR build — they run in Vercel functions in prod. `react-router dev` doesn't serve
// /api, so mirror each endpoint here by calling the same Node core (POST → JSON). One middleware,
// dispatched by path, keeps dev and prod behaviour identical.
const devApi: PluginOption = {
  name: 'dev-api',
  apply: 'serve',
  configureServer(server) {
    const route = async (raw: string, path: string) => {
      const body = JSON.parse(raw || '{}')
      // @ts-expect-error - untyped Node-only ESM modules (live in api/, outside the src TS project)
      const ots = () => import('./api/_ots-core.mjs')
      // @ts-expect-error - untyped Node-only ESM module
      const prov = () => import('./api/_provenance-core.mjs')
      if (path === '/api/ots') return (await ots()).handleOts(body)
      if (path === '/api/session') return (await prov()).handleSession(body)
      if (path === '/api/sign') return (await prov()).handleSign(body)
      throw new Error('not found')
    }
    for (const path of ['/api/ots', '/api/session', '/api/sign']) {
      server.middlewares.use(path, (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; return res.end('Method Not Allowed') }
        let raw = ''
        req.on('data', (c) => { raw += c })
        req.on('end', async () => {
          try {
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify(await route(raw, path)))
          } catch (err) {
            res.statusCode = (err as Error)?.message === 'bad request' ? 400 : 502
            res.end(JSON.stringify({ error: 'api failed' }))
          }
        })
      })
    }
  },
}

export default defineConfig({
  plugins: [devApi, reactRouter(), tsconfigPaths()],
  server: {
    host: true, // bind 0.0.0.0 so the WSL2 dev server is reachable from the Windows browser
  },
})
