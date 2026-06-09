# Thesaurus Popover — Jitter Audit

**Scope:** the word-cycle synonym popover in `src/editor/suggestions/ThesaurusPopover/`
plus its decoration backend in `src/editor/extensions/RedHighlightExtension.ts` and the
`handleHintChange` dispatcher in `src/editor/TiptapEditor.tsx`.

**Method:** static read of the full popover stack. No code changed. Behaviour claims below
are traced to specific lines; the two marked *(unverified)* should be confirmed in-browser.

**TL;DR.** Steady-state reel *scrolling* is actually well built (compositor-only `translateY`,
`reelPos` deliberately kept out of the geometry memo — see `ThesaurusPopover.tsx:611`). The
jitter is concentrated at **open** and **commit**, and it is not one animation gone wrong —
it's **a chain of discrete, instant geometry snaps that the code treats as if they were
smooth CSS transitions that no longer run.**

---

## Root cause (read this first)

### R1 — The reflow animation is disabled in the default path. *(High)*

The whole expand/compress reflow is built to animate via CSS transitions on `min-width` and
`letter-spacing` (armed only when `HintState.animate === true` — see
`RedHighlightExtension.ts:164` and `:179`). The transition machinery, the `settled` model-box
trick, the three-step "arm the transition then change the value" dance in
`usePopoverLayout.ts:78-94`, and the `REFLOW_OPEN_MS` gating all exist to make that transition
smooth on phones.

**But every caller in the default path passes `animate: false`:**

- Open: `openCycleForElement` → `applyLayout(..., overlay, false)` (`usePopoverLayout.ts:228`).
  The elaborate `animate` branch at `:78-94` is never entered — nobody calls `applyLayout`
  with `animate = true`.
- Commit / close: `closeWithAnimation` → `onHintChange(..., false)` (`usePopoverLayout.ts:127`).
- Wrap commit: instant by design (`ThesaurusPopover.tsx:154`).

The only path that sets `animate: true` is the experimental FLIP branch behind `?flip=1`
(`usePopoverLayout.ts:135-143`). So in production **`min-width` and `letter-spacing` snap
instantly on every open and commit.** The popover does not animate its reflow at all.

**Why this matters for the bug hunt:** the code *reads* as if it animates — the comments say
"OPEN is snappy," "smooth on phones," "ease the reflow back" — so tuning `REFLOW_OPEN_MS`,
`REFLOW_EASE`, or the easing curves changes nothing visible. Anyone debugging by adjusting the
animation constants is editing dead code. The jitter is the *snaps*, and there are several of
them per interaction (R2).

### R2 — One "open" is 2–3 discrete geometry jumps, not one. *(High)*

Opening a word walks through several independent layout states, each applied instantly (per
R1), each a visible jump:

1. **Provisional** (`openCycleForElement`, `usePopoverLayout.ts:199-206`): focus decoration at
   the word's *natural* width, `alignFraction: 0.5`, `synonyms` = the original word repeated
   ×8 (`Array(CYCLE_SIZE).fill(displayWord)`). Card renders at natural size showing the
   original word in every slot.
2. **Synonyms resolve** (the `getSynonyms(...).then` at `:208-229`): `setCycle` swaps in the
   real `synonyms` + real `minWidth` + `reelPos`, then `applyLayout` computes the real
   `alignFraction`/`naturalWidth` and dispatches the real `minWidth`. The focused word pops
   from natural width to `minWidth`, neighbours compress, the reel fills with real synonyms,
   and the card resizes and shifts. (Near-instant if the prefetch cache is warm; a network RTT
   otherwise.)
3. **`settled` flip** (`ThesaurusPopover.tsx:536-542`): 150 ms after the `minWidth` change,
   `settled` goes `false → true` and bumps `geomNonce`, which switches the geometry from the
   computed **model box** to the **live** `getBoundingClientRect()` box (R3). Another shift.

Three states, three snaps, no tweening between them → reads as "settling"/jitter on every open.

---

## Findings

### F1 — `settled` model→live box swap is a guaranteed pop. *(High)*

`ThesaurusPopover.tsx:571-578`: while `!settled` the geometry derives the reserved box
analytically —
`boxLeftC = naturalLeftC − alignFraction·exp`, `boxRightC = boxLeftC + ceil(minWidth)` —
and once `settled` it switches to the browser's live rect (`rect.left/right`). `slotLefts`,
the card `left`, and `width` all derive from those bounds (`:581-590`), so when the source
flips, the entire card and reel translate by `(model − live)`.

The model and the live box **will not match to the pixel**: the live box includes the
`min-width` inline-block's real metrics, the applied `letter-spacing` compression on
neighbours, and sub-pixel rounding, none of which the analytic model reproduces exactly. So
~150 ms after every open the card jumps by a few px horizontally. This fires even if nothing
else changes. It's the most reliably reproducible single jolt.

### F2 — Three overlapping scroll/resize handlers; one rebuilds the PM DOM. *(Medium)*

While a cycle is open there are **three** independent subscriptions to scroll/resize:

- `usePopoverLayout.ts:39-45` — scroll(capture) + resize → `forceUpdate`.
- `usePopoverLayout.ts:164-170` — resize → `applyLayout` (dispatches PM transactions).
- `ThesaurusPopover.tsx:523-529` — scroll(capture) + resize → `geomNonce++`.

Problems:
- **Redundancy / thrash:** every scroll event triggers both `forceUpdate` (a re-render that
  recomputes nothing in `geom`, since none of its deps change) and `geomNonce++` (a real
  `geom` recompute doing multiple `getBoundingClientRect()` + `document.createRange()`
  measurements). `capture: true` means *any* scroll in the document counts — so scrolling the
  paper with the popover open forces synchronous layout every scroll frame.
- **Mid-gesture DOM rebuild:** on resize, `applyLayout` calls `onHintChange(null, null)` then
  re-dispatches (`usePopoverLayout.ts:62, 94/96`), which rebuilds the `.scas-focused`
  ProseMirror node. Any in-flight `committing` compositor transform (`ThesaurusPopover.tsx:682`)
  lives on that node and is discarded. On mobile the iOS keyboard/toolbar show-hide fires
  `resize` mid-interaction — so a commit animation can be yanked out from under the user.
  *(Mobile-specific, unverified.)*

### F3 — Neighbour-row opacity flickers during keyboard cycling. *(Medium)*

Neighbour rows are revealed only while `moving` is true: `reveal = moving ? 1 : max(0, 1 − a·2.4)`
(`ThesaurusPopover.tsx:651`), and the row's opacity `transition` is `'none'` while moving but
`'opacity 160ms ease'` at rest (`:672`). `moving` is turned off by `scheduleMovingOff(120)`
(`:77-82`) ~120 ms after motion stops.

So a press of `j`/`k` does: `moving → true` (neighbours snap to full opacity, transition off),
glide ~≤280 ms, `moving → false`, neighbours fade out over 160 ms. Press again *during* that
160 ms fade and they snap back to full opacity instantly. Rapid cycling = neighbours
strobing snap-in / fade-out / snap-in. The `120 ms` off-delay and the `160 ms` fade are
shorter than a comfortable key-repeat interval, so this is easy to hit. The origin ink-dot has
the same hard `1/0` toggle with no transition (`:700`).

### F4 — `alignFraction` starts at a placeholder and is corrected async. *(Medium)*

`openCycleForElement` seeds `alignFraction: 0.5` (`usePopoverLayout.ts:204`), but the true
value is only known after `computeLineCompressionRange` runs inside `applyLayout`, which runs
inside the synonym `.then`. `alignFraction` is a `geom` dependency
(`ThesaurusPopover.tsx:611`), so the box's left edge is computed against `0.5` first and the
real fraction second → contributes a horizontal shift to the step-2 jump in R2. For a word near
the right margin the real fraction can be far from `0.5`, so the shift is large.

### F5 — `rowHRef.current = geom.rowH` is a write during render. *(Low)*

`ThesaurusPopover.tsx:616` mutates a ref in the render body. It feeds the pointer/wheel
handlers (drag→slot conversion, `rowH`). It works today, but it's a render side-effect: under
StrictMode double-invoke or a bailed render it can read stale, making one drag frame convert
pointer travel to slots at the wrong scale (a one-frame velocity blip). Belongs in a layout
effect or in `geom` consumers directly.

### F6 — Drag velocity can spike on high-rate pointers. *(Low)*

`onPointerMove` smooths velocity as `vel = vel·0.6 + (dPos/dt)·0.4` with
`dt = max(1, timeStamp − lastT)` (`ThesaurusPopover.tsx:425-426`). On 120 Hz pointers `dt`
floors at `1 ms`, so a small `dPos` over a sub-millisecond real interval reports an inflated
slots/ms. `fling` consumes that (`:468-470`), so an intended gentle release can occasionally
coast instead of committing (and vice-versa). Reads as the reel "not doing what I told it."
Inconsistent rather than continuous jitter.

---

## Suggested direction (not implemented — for discussion)

1. **Decide whether the reflow animates at all, then make the code say so.** Either re-enable
   the transition path (route open/commit through `animate: true` and verify the CSS
   transitions in `RedHighlightExtension.ts` fire) *or* delete the dormant machinery
   (`usePopoverLayout.ts:78-94`, the `settled` model-box branch, `REFLOW_OPEN_MS` gating,
   `?flip=1`). Right now it's Schrödinger's animation and that's what's burning debugging time.
2. **Collapse the open into one geometry commit.** Don't render the provisional
   original-word-×8 state with placeholder `alignFraction`; ideally compute the box once
   synonyms are known and apply a single layout. If a warm prefetch is guaranteed (CLAUDE.md
   says opens are prefetched), the placeholder step buys little and costs a visible jump.
3. **Kill the `settled` snap (F1).** Pick one coordinate source. If the reflow is instant
   (current reality), there's no transition to outrun — just use the live box from frame one
   and drop the model box entirely.
4. **One scroll/resize owner (F2).** Consolidate to a single rAF-throttled handler that
   recomputes geometry; do *not* rebuild the PM decoration on resize while a gesture is active.
5. **Make `moving` hysteresis longer than key-repeat, or keep neighbours mounted at low
   opacity (F3)** so cycling doesn't strobe.

## Quick repro checklist (to confirm in-browser)

- [ ] Open a red word with the cache warm → watch for a ~150 ms post-open horizontal jump (F1).
- [ ] Open a red word near the right margin → larger jump (F4).
- [ ] Hold `k` to cycle quickly → neighbour rows / origin dot strobe (F3).
- [ ] Open popover, scroll the paper → per-frame layout cost (F2).
- [ ] Mobile: open a word, then trigger the keyboard/toolbar resize mid-commit (F2, mobile).
- [ ] Set `?flip=1` and compare — this is the *only* path that actually animates the reflow.

---

# Round 2 — re-audit after the fixes (commits `89d7a35`, `1e85049`, `969cebd`)

**Resolved:** F1 + F4 (the `settled` model→live swap and the `alignFraction` placeholder are
gone — `geom` now uses the live rect from frame one, single coordinate source). F3 (neighbour
strobe — linger raised to 300 ms, transition only disabled for a continuous drag). The *commit*
half of R1 (the after-text now FLIP-slides home by default instead of snapping).

Remaining sources of small jumps / flicker, in priority order:

### N1 — Open still snaps; only commit animates now (asymmetry). *(Medium-High)*

R1 was fixed for **commit** (FLIP promoted to default, `usePopoverLayout.ts:24-29`) but **open
was left on the instant path**: `openCycleForElement` still calls
`applyLayout(domPos, …, /*animate*/ false)` (`usePopoverLayout.ts:228`). So opening a word
abruptly grows the reserved box and compresses the line in one frame, while committing/closing
eases the same layout back. The eye reads the mismatch as "jumps open, glides shut." This is
now the most visible remaining jolt. **Fix:** mirror the commit FLIP on open — measure the
after-text's natural left, apply the compression instantly, then invert it with a
`translateX` and ease to 0 (the box's `min-width` grow can't transition, but its *visible*
effect is exactly the after-text sliding right, which is what FLIP animates). Same technique
already proven in `closeWithAnimation:135-144`.

### N2 — The reel word's commit slide-home doesn't arm its transition → it snaps. *(Medium)*

`ThesaurusPopover.tsx:667-671`: when `committing` flips `false → true`, the chosen span gets
**both** `transform: translate(naturalInCard−slotLeft, reelSettle)` **and**
`transition: transform 240ms` applied in the *same* React commit / single style recalc. Per the
project's own note (`usePopoverLayout.ts:85-89`) and the FLIP path's forced-reflow dance
(`:140-142`), Chromium will **not** start a transition when the `transition` property and the
animated value change in one flush with no prior armed state — so the chosen word **jumps** to
its home x/y while the surrounding after-text (which *does* arm correctly via the FLIP reflow)
glides. The same applies to the row's `committing` opacity (`:654/:658`): neighbours likely
vanish instantly rather than fade. Net: on commit the text slides but the word pops — a small
mismatch jump. **Fix:** keep a permanent `transition: transform …` on the span and only toggle
the `transform` value (so the transition is always armed), or render one frame at the start
value with `transition:none`, force a reflow, then set the target — exactly as the open and
FLIP paths do. *(Confirm in-browser — browser-dependent.)*

### N3 — Three scroll/resize subscriptions still overlap; resize rebuilds the PM DOM. *(Low-Medium)*

Still present and unconsolidated: `forceUpdate` (`usePopoverLayout.ts:39-45`), `geomNonce`
(`ThesaurusPopover.tsx:526-532`), and resize→`applyLayout` (`usePopoverLayout.ts:164-170`). On
scroll, two of them recompute geometry (`getBoundingClientRect` + `document.createRange`) every
event → layout thrash if the paper is scrolled with the popover open. On resize the third
re-dispatches PM transactions and rebuilds the `.scas-focused` node, discarding any in-flight
`committing`/FLIP transform — so a resize mid-commit (iOS keyboard/toolbar show-hide) yanks the
animation and jumps. **Fix:** one rAF-throttled geometry owner; skip the resize re-layout while
`committing` is true.

### N4 — Reel jumps vertically on synonym-load for a managed (re-opened) word. *(Low)*

The reset effect keyed on `[cycle?.from, cycle?.synonyms]` sets `reelRef = cycle.reelPos`. The
provisional state seeds `reelPos: 0` (`usePopoverLayout.ts:203`); when synonyms land,
`reelPos` becomes `findIndex(current word)` (`:222`), which for a previously-cycled word is
non-zero — so the reel **snaps from slot 0 to slot N** the instant the fetch resolves. Normal
red words keep `reelPos: 0` (no jump); only re-opened managed words are affected. **Fix:** seed
the provisional `reelPos` to the resolved value up front, or ease to it instead of resetting.

### N5 — Cold-open flash: original-word-×8 → real synonyms + box grow. *(Low)*

While `getSynonyms` is in flight the reel shows the original word in all 8 slots at natural
width; on resolve it pops to 8 real synonyms **and** the box grows (N1). Warm prefetch hides
this, but a cold/cache-miss open flashes the placeholder then jumps. Tied to N1 — fixing the
open animation (and/or holding the card hidden until synonyms resolve on a cold fetch) covers it.
