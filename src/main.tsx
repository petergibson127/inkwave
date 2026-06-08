import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/index.css'
import App from './App.tsx'

// Build marker — confirms the live build in the console (helps catch stale-cache situations).
console.log('%c[inkwave] build: commit-anim-r16', 'color:#5c2d8a;font-weight:bold')

const root = document.getElementById('root')
if (!root) throw new Error('Root element not found')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Register the service worker for offline support and PWA install — PRODUCTION ONLY.
// In dev a cache-first SW poisons the dev server: it serves a stale cached app shell and
// JS, so live code changes never appear. So in dev we do the opposite — actively unregister
// any previously-installed worker and clear its caches, which also un-poisons a browser that
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
