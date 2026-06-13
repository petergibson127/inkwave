// Auth is OPTIONAL and only needed for the paid (M6) tier — the free writing + sync tiers never
// require an Inkwave account. The whole auth layer is gated on the Clerk publishable key: until
// it's set the login UI is hidden and Clerk is never loaded (zero impact, like OneDrive).

export const CLERK_PUBLISHABLE_KEY = import.meta.env?.VITE_CLERK_PUBLISHABLE_KEY as string | undefined

export function authEnabled(): boolean {
  return !!CLERK_PUBLISHABLE_KEY
}
