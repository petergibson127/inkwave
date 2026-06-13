// The api/ Node modules ship no types and are imported as `any` (the typed boundary lives in
// src/provenance/*.ts). Used by the M3 receipt interop test, which drives the real server core.
declare module '*.mjs'
