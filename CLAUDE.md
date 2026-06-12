# Inkwave Scroll — CLAUDE.md

Project context for Claude Code sessions. Read this first.

## What this is

**Inkwave Scroll v0.1** — the free tier of Inkwave, a calm writing environment for
short academic/philosophical writing. Solo developer: Peter (Brisbane). Target users:
STEM & philosophy honours students writing short documents.

The defining mechanic is **SCAS** (Stochastically Constrained And Suggested) — words
outside a per-paragraph "active vocabulary" glow red, and the writer can cycle through
thesaurus synonyms to replace them. The friction becomes an interpretable authorship
trace (provenance) without surveillance.

This is the **free Scroll tier only**. The paid **Tablet** tier (Clay/Stone commitment
states, weathering, hollow clocks, sentence-level glyphs, etc.) is Phase 2+ and **must
not be built here**. See the canonical docs for the full deferred list.

## Canonical documentation (lives OUTSIDE the repo)

On the Windows host, accessible from WSL at:
`/mnt/c/Users/peter/OneDrive/Documents/Claude/Projects/Inkflow Studio/`

Read in this order:
1. **`inkwave-scroll-v01-build-spec.md`** — start here. The focused build spec for v0.1.
   Tech stack, document model, SCAS scope, the 4-week build plan, explicit out-of-scope list.
2. `inkwave-architecture-decisions-v5.md` — full ~60-page architecture. Reference only.
3. `claude-session-memory.md` — session-by-session decision history; *why* choices were made.

Do **not** build against the older v3/v4 architecture docs (audit trail only).

## Tech stack

Vite + React 18 + TypeScript + Tailwind 3 + Tiptap (on ProseMirror) + OPFS/IndexedDB.
**React Router v7 in framework mode** (`@react-router/dev` Vite plugin) for routing +
build-time prerendering. `uuid` for IDs. Hosting: Vercel. Domain: `inkwave.studio`.

```
pnpm dev        # react-router dev (http://localhost:5173)
pnpm build      # react-router build — outputs static client + prerendered HTML to build/client/
pnpm typecheck  # react-router typegen && tsc -b
pnpm preview    # vite preview --outDir build/client
pnpm test       # vitest (NOTE: no tests written yet)
pnpm test:e2e   # playwright (none written yet)
```

**Routing / SSR model.** `react-router.config.ts` sets `ssr: false` (SPA mode, no runtime
server) + `prerender(['/', '/about'])` — `/` and `/about` are rendered to static HTML at
build for SEO + instant first paint. The editor IS the landing page (`/`): the route
prerenders the empty-editor SHELL (`<Scroll>` chrome + `<EmptyEditorSurface>` facsimile,
same CSS classes as the live editor — see `src/editor/Scroll.tsx`), then the real Tiptap
editor mounts client-side in its place (ProseMirror can't SSR). The prerendered page is a
direct CSS function of the shared components, so style changes propagate automatically.
Flip `ssr: true` later when the Phase-2 "rooms" model needs per-request rendering.

Package manager is **pnpm** (`packageManager: pnpm@10.33.2`), not npm.

## Build progress (vs. build-spec 4-week plan)

- **Week 1 — Foundation: DONE.** `/edit` route, Tiptap editor, OPFS autosave (200ms
  debounce), restore-on-refresh, IndexedDB metadata index, hand-rolled PWA
  (`public/manifest.webmanifest` + `public/sw.js`).
- **Week 2 — SCAS variant: DONE (and gone beyond spec).** Per-paragraph stochastic
  re-ranking, red highlighting, Datamuse thesaurus, limit selector, compliance tracking,
  the inline word-cycle UI (Stages A & B done; C & D in progress).
- **Provenance spine M0 — SCAS engine swap: DONE.** Building the v4 spec
  (`inkwave-scroll-v01-provenance-spine-build-spec-v4.md`), which supersedes the old
  Week-3 plan. The Week-2 per-paragraph `ranking.ts` model is replaced by `scas/engine.ts`
  + `scas/state.ts` + `scas/controller.ts`: a rotating seed-derived exclusion set `S_v`
  (local seed in M0; server-held from M3) and the ban-credit/satisfied/immunity state
  machine. `RedHighlightExtension` now *renders* engine state (locked ∪ liveKicks) instead
  of recomputing vocab. Delete a kicked word → it locks (forced kick on retype, suppressed
  from popovers); swap → resolves; verdicts freeze at commit so `S_v` rotation never
  reflows committed text. Unit-tested (`scas/engine.test.ts`, the repo's first tests) +
  browser-verified. Next: M1 (snapshots + local hashing).
- **Week 3 — Snapshots + provenance: NOT STARTED** (now tracked as M1+ of the spine).
  Only an `appendEventLog` stub exists in `opfs.ts`. No `snapshots.ts`, no `provenance/`
  module yet.
- **Week 4 — Glyphs, dashboard, certification: NOT STARTED.** No `glyphList.ts`,
  `ParagraphGlyphExtension`, `GlyphDashboard`, or certification PDF/QR. Glyphs are the
  stated v0.1 *differentiator* — don't trim them.

## Code map

```
app/                                   # React Router v7 framework layer (thin; imports from src/)
  root.tsx                             # document shell (<html>/<head>), <Meta>/<Links>, fonts, global CSS
  routes.ts                            # route config: index('routes/home.tsx') + 'about'
  routes/home.tsx                      # '/' = the editor (renders <Edit/>) + SEO meta()
  routes/about.tsx                     # '/about'
  entry.client.tsx                     # hydrateRoot + service-worker registration + build marker
src/
  routes/Edit.tsx                      # loads/creates the active doc; renders the shell until it loads
  editor/Scroll.tsx                    # shared scroll-paper chrome + EmptyEditorSurface facsimile (CSS-function shell)
  types/document.ts                    # InkwaveDocument, Snapshot, ProvenanceEvent types
  editor/
    TiptapEditor.tsx                   # editor surface, scroll-head chrome, footer, prefetch
    extensions/RedHighlightExtension.ts# PM plugin: red decorations + hint badges + line compression
    suggestions/
      thesaurus.ts                     # Datamuse lookups, in-memory cache, form-matching (sp=)
      textMetrics.ts                   # canvas text measurement
      CycleHintPanel.tsx               # the j/k/space/tab/esc hint strip
      ThesaurusPopover/                # the word-cycle UI (split into focused modules)
        ThesaurusPopover.tsx           #   events (keyboard, pointer, outside-tap) + render
        usePopoverLayout.ts            #   cycle state + openCycleForElement + compression dispatch
        popoverGeometry.ts             #   posOf, measureNaturalLineRight, computeLineCompressionRange
        popoverFallbacks.tsx           #   buildSynonyms, displayFor (⌫)
        popoverConstants.ts            #   CYCLE_SIZE=8, DELETE_SENTINEL, CycleState type
  scas/
    ranking.ts                         # mulberry32 PRNG, getActiveVocab, isInVocab, getStems
    compliance.ts                      # accepted/(accepted+ignored) ratio, React context
  data/wordFrequency.ts                # ~30k-word Norvig/Google list (one big string[])
  storage/
    opfs.ts                            # document persistence + appendEventLog stub
    indexeddb.ts                       # {id,title,updatedAt} metadata index for fast listing
  components/LimitSelector.tsx         # the N selector (500–5000 or infinite)
```

## Non-obvious conventions & invariants (READ BEFORE EDITING)

- **SCAS ranking must never retroactively re-highlight prior text.** Vocabulary is keyed
  on `(scasSessionSeed, paragraphIndex, N)` in `ranking.ts`. Changing N only affects
  paragraphs written after the change. `clearRankCacheFrom` exists to enforce this. This
  is the single most important behavioural invariant — preserve it.
- **`infinite` mode** returns a `Proxy`-backed `FULL_VOCAB` whose `.has()` always returns
  true, avoiding a 30k-entry Set. Default N for a fresh doc is `'infinite'`.
- **Enter = hard break (stay in paragraph); Shift+Enter = new paragraph.** Inverted from
  the usual editor default, set in `TiptapEditor.tsx` via the `enterBehavior` extension.
- **The word-cycle replaced the original dropdown popover.** Don't reintroduce a dropdown.
  Cycle slots: index 0 = the original word, 1–6 = synonyms (cycled if Datamuse returns
  fewer), 7 = ⌫ delete sentinel. j decrements index, k increments; current sits in the
  middle row, prev above, next below.
- **`isInVocab` filter is intentionally NOT applied to suggestions** — all Datamuse
  candidates are shown and the writer decides fit (a deliberate Stage A decision).
- **Line compression** (`computeLineCompressionRange`) tightens letter-spacing around a
  focused word to absorb its min-width expansion *in place*, so the popover doesn't reflow
  the paragraph. This is fiddly, pixel-measured, and has had many regression fixes — change
  it carefully and test wrapped lines + first-word-on-line cases.
- **Provenance events** should funnel through `compliance.ts` (accept/ignore) and the
  `appendEventLog` stub now, so the Week 3 event log can adopt them without rework.
- **Document IDs are stable UUIDs** — they become room identifiers in the future room
  model (Phase 2+). Don't change the ID scheme.
- **No automated tests exist yet.** `ranking.ts` (`getStems`, `getActiveVocab`) and
  `thesaurus.ts` form-matching are the highest-value pure-function unit-test targets.

## Style

Match the surrounding code: terse purposeful comments explaining *why*, section dividers
(`// ─── … ───`), single-responsibility modules. Calm visual identity: ink/purple
(`#5c2d8a` / `#9b5ccc`), parchment/cream, serif body (IM Fell DW Pica / EB Garamond).
Commit messages: `feat:` / `fix:` / `refactor:` prefixes, present tense.
