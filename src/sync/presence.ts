// Advisory multi-device guard. Each browser gets a stable id (localStorage — so reopening the SAME
// browser never false-alarms, but a DIFFERENT computer has a different id). We stamp it into the
// synced file (the .trace.json's `session` field) on every write; on load + periodically we read the
// file back and, if it was last written by ANOTHER device very recently, warn that the document looks
// open elsewhere. Purely advisory — the document is always editable and always saved locally, so a
// session left open on another machine can NEVER lock the writer out.

const DEVICE_KEY = 'inkwave:device-id'

// A short random id (not security-sensitive — just to tell devices apart).
function randomId(): string {
  try {
    const a = new Uint8Array(8)
    crypto.getRandomValues(a)
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return `d${Date.now().toString(36)}`
  }
}

export function deviceId(): string {
  if (typeof localStorage === 'undefined') return ''
  try {
    let id = localStorage.getItem(DEVICE_KEY)
    if (!id) { id = randomId(); localStorage.setItem(DEVICE_KEY, id) }
    return id
  } catch {
    return ''
  }
}

// How recently another device must have written for us to treat it as "active". Generous vs the
// ~20s sync throttle, tight enough that a long-abandoned session stops warning.
const ACTIVE_WINDOW_MS = 2 * 60 * 1000

/** Given the `session` + `exportedAt` read back from the synced file, is another device active now? */
export function isOtherDeviceActive(session: string | undefined, exportedAt: string | undefined): boolean {
  if (!session || session === deviceId()) return false
  if (!exportedAt) return false
  const age = Date.now() - new Date(exportedAt).getTime()
  return Number.isFinite(age) && age >= 0 && age < ACTIVE_WINDOW_MS
}
