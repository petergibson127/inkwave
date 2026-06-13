import { startTransition, StrictMode, type ReactNode } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { HydratedRouter } from 'react-router/dom'

// Build marker — confirms the live build in the console (helps catch stale-cache situations).
console.log('%c[inkwave] build: crisp-snap-r37', 'color:#5c2d8a;font-weight:bold')

// Wrap the app in Clerk ONLY when configured (paid-tier auth, M6). Dynamic import keeps Clerk out
// of the bundle entirely when unconfigured, and entry.client is client-only so it never touches
// the prerender/SSR build. The publishable key is public (safe in the client).
async function bootstrap() {
  const pk = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined
  let tree: ReactNode = <HydratedRouter />
  if (pk) {
    const { ClerkProvider } = await import('@clerk/clerk-react')
    tree = <ClerkProvider publishableKey={pk}>{tree}</ClerkProvider>
  }
  startTransition(() => {
    hydrateRoot(document, <StrictMode>{tree}</StrictMode>)
  })
}
void bootstrap()

// Register the service worker for offline support and PWA install — PRODUCTION ONLY.
// In dev a cache-first SW poisons the dev server: it serves a stale cached app shell and JS,
// so live code changes never appear. So in dev we do the opposite — actively unregister any
// previously-installed worker and clear its caches, which also un-poisons a browser that
// installed the SW during an earlier session.
if (import.meta.env.PROD) {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((err) => {
        console.warn('[inkwave] SW registration failed:', err)
      })
    })
  }
} else if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((regs) => regs.forEach((r) => r.unregister()))
  if ('caches' in window) caches.keys().then((keys) => keys.forEach((k) => caches.delete(k)))
}
