## ADR-035: Loading & Motion Choreography — Orchestrated Cascade, Directional Data-Draw, No Spinners

**Status**: Accepted (2026-07-15)
**Related**: ADR-012 (shadcn/ui + TanStack ecosystem — the component layer these rules bind to), [`docs/11-design-identity.md`](../11-design-identity.md) §2.6 (motion tokens — durations/easings this ADR consumes) and §2.10 (post-login cohesion — rule 7 "one interaction curve, one duration" stays authoritative for hover/press feedback)

### Context

Dashboard-class screens (Overview, Insight-style analytics, campaign reports, the donor-facing thermometers) currently have no codified rule for **how content appears**: what animates on first load, in what order, how charts redraw when the operator switches a metric or filter, and what a modal replays when it opens. Left unspecified, each PR improvises — some screens pop in all at once, some shimmer generic skeletons, some would inevitably grow a spinner.

We analysed frame-by-frame a reference motion study by Barly ([Autumn — CRM Dashboard — Insight](https://x.com/barlydesign/status/2077219199097896965), 19.5 s loop) that demonstrates a coherent, professional loading-and-transition language for exactly our product shape (sidebar shell + KPI row + chart cards). The observed sequence:

1. **Shell first (t≈0.5–1.0 s)** — the canvas appears near-blank with just the brand mark and the **active nav item's highlight pill** (the "where am I" anchor renders before the menu labels themselves), then sidebar items cascade top→bottom, then page title, then filter bar. (The demo animates the shell for cinematic effect; our rule 1 below keeps the shell static instead — SSR gives us the orientation anchor for free.)
2. **Cascade in reading order (t≈1.0–2.0 s)** — card frames + titles fade in, then axes and Y-labels, then X-axis labels sweeping left→right, then the KPI stat row staggering left→right (first KPI fully opaque while the fourth is still faint).
3. **Directional data-draw (t≈1.8–3.4 s)** — the main chart paints **left→right like a wave**: grey "ghost" dots appear one beat ahead of the orange value fill that rises from the baseline; the health timeline bar sweeps left→right; segmented progress bars extend segment-by-segment; KPI numbers land with their delta badges.
4. **Absence of data is drawn, not blank** — future/no-data regions render as diagonal hatching; ghost dots show the grid before values exist. There is **no spinner anywhere** in the whole sequence.
5. **Metric/tab switch (t≈5.5–7 s)** — the tab indicator slides; old data exits with a fast fade **while axes and card frame persist** (the frame never blinks); the new series re-draws with the same left→right sweep, shorter than the initial one; the Y-axis rescales with a label cross-fade. A metric switch may change chart *type* (dot-matrix → line + hatched confidence band → bars + dashed trend) under the same sweep.
6. **Inspection (t≈4–5 s)** — hovering the chart shows a vertical dotted crosshair, a floating tooltip card (date + value), and a dark pill marking the hovered date on the X axis — all instant, cursor-locked. The inspection anchor **persists**: when the cursor leaves the chart, and even across a metric switch and redraw, the crosshair + tooltip re-anchor on the same date, with a point marker on the new series.
7. **Modal (t≈13–15.5 s)** — scrim dims (with a slight blur/desaturation of the page behind), the dialog enters **with its content already ghosted** — header + title first, then sections ghost-in top→bottom; the body is never blank white. Then the mini-cascade plays once: timeline fills, three segmented meters (green success / orange failure / purple duration) fill left→right with a soft gradient at the leading edge, values count up. Exit is a plain fade + scrim lift, faster than entrance — and the dashboard behind is untouched: closing a modal never re-runs the page cascade.

The demo's ~3 s cascade is cinematic pacing for a showreel; a working CRM must feel faster. But the *grammar* — shell → structure → data, always directional, placeholders shaped like the data, absence drawn explicitly — is exactly the "purposeful, not decorative" motion posture `docs/11` §2.6 already mandates, made concrete.

### Decision

Adopt the following **choreography rules** for every operator-facing screen that loads or transitions data. They bind to the existing motion tokens in `docs/design/shared/tokens.css`; two tokens are added (rule 2).

#### A. Initial load — the orchestrated cascade

1. **Shell renders instantly and never animates.** Sidebar, topbar, page title, filter/action bar are static structure — no fade, no slide, ever. Only *content* participates in choreography. (SSR/streaming shells satisfy this for free.)
2. **Cascade in reading order with a fixed stagger.** Content blocks (cards, KPI tiles, table sections) enter top→bottom, left→right, each `opacity 0→1` + `translateY(4px)→0`, `--duration-slow` (250 ms) `--ease-out`, offset by a new token `--stagger-step: 50ms` (added to tokens.css alongside `--duration-sweep: 600ms`). Delay is `calc(var(--index) * var(--stagger-step))` — pure CSS `animation-delay`, no JS orchestration library.
3. **Container before content.** A card's frame + title enter first; axes/labels next; data last. Never paint a value before the structure that gives it meaning.
4. **Total choreography budget: 1 000 ms** from first content paint to fully-settled screen (the reference's 3 s is demo pacing — we cap at one third). The cascade is presentational only: **every element is interactive the moment it is painted**; motion must never gate input.
5. **Placeholders are data-shaped ghosts, not generic shimmer and never spinners.** While a query is in flight, render the final geometry in ghost form: grey dot-grid for a dot-matrix chart, hairline axes for a line chart, muted track for a progress meter, fixed-height rows for a table. Reserve the existing shimmer `Skeleton` for text-shaped unknowns (names, paragraphs). Loading spinners remain banned on content surfaces (`docs/11` §2.6); the only sanctioned spinner is the existing in-button loading state.
6. **Zero layout shift.** Ghosts occupy the exact final dimensions. The cascade animates `opacity`/`transform` only — nothing reflows when real data replaces a ghost.
7. **Data draws directionally — and only while its container still covers it.** Time-series charts sweep left→right over `--duration-sweep` (600 ms): ghost points lead, value fill follows (clip-path sweep or the chart library's native draw-on). Progress meters fill left→right from 0 to value via a **rounded clip-path reveal** (`.meter-reveal`, `inset(0 100% 0 0 round var(--meter-radius))`) — never a bare `scaleX`, which squashes the caps. Data-draw clocks **chain to their container's cascade slot**: `--cascade-i` inherits, and `.sweep-in`/`.meter-reveal` delay by `calc((var(--cascade-i) + 1) * var(--stagger-step))` (capped at 400 ms per rule 4) so a draw never plays invisibly behind a still-hidden parent. KPI numbers count up over the same window — but a count-up may **only animate a value the operator has not seen yet**: the hook gates on the host still being hidden by its entrance (`opacity: 0`) and otherwise renders the final value instantly. A server-rendered number that is already painted never resets to 0 and re-counts — that reads as data regressing, the worst possible glitch on a trust surface.
8. **Absence of data is drawn explicitly.** Future periods, empty buckets, and not-yet-computed regions render as diagonal hatching or ghost dots — a visible "no data here" texture, never blank whitespace inside a chart frame. (Empty *datasets* keep the illustrated empty-state pattern from `docs/11` §2.5 — hatching is for partial absence inside otherwise-populated visualisations.)

#### B. Data transitions — filter, tab, metric switch

9. **The frame persists; only data swaps.** On any filter/tab/metric change: axes, card frame, and title remain mounted; the old series fades out in `--duration-normal` (150 ms) `--ease-in`; the new series re-draws with the rule-7 sweep. The container never unmounts, blanks, or flashes.
10. **Axis rescale cross-fades.** When the value domain changes, old tick labels fade out as new ones fade in (`--duration-normal`); the axis line itself never disappears.
11. **Selection indicators slide, they don't re-render.** Tab underlines and segmented-control thumbs move by `transform` translation (`--duration-normal` `--ease-out`) between positions.
12. **Background refetches never replay choreography.** The cascade and sweep run **once per navigation or explicit user action**. TanStack Query background revalidation, SSE-driven updates, and polling swap values in place (at most a 150 ms cross-fade on the changed value). A dashboard that re-sweeps on every refetch reads as broken.

#### C. Inspection — hover & tooltips

13. **Inspection is instant and cursor-locked.** Chart crosshair (vertical dotted rule), tooltip card, and axis pill appear within `--duration-fast` (100 ms) and track the cursor with no easing lag. Tooltip = floating card with `--shadow-overlay` (it genuinely floats — §2.10 rule 4); the axis marker is a dark pill anchored on the hovered tick. Hover/press feedback elsewhere stays exactly §2.10 rule 7 (150 ms `ease-out`, colors only).
14. **Inspection state survives data swaps.** The crosshair/tooltip anchor is keyed on the inspected *point in time*, not on the rendered series: when the operator switches metric or tab, the anchor persists through the redraw and re-attaches to the same date on the new series (with a point marker), rather than vanishing and forcing re-hover. It clears only on explicit dismiss or when the new domain no longer contains the anchored point.

#### D. Overlays — modals, popovers, panels

15. **Modal entrance**: scrim fades to `--color-overlay` + dialog `opacity 0→1`/`scale(0.98)→1`, `--duration-slower` (300 ms) `--ease-out`. **Exit is faster than entrance**: 200 ms `--ease-in`, a plain fade — no reverse cascade. Closing an overlay never re-runs any choreography on the page behind it.
16. **Modal content replays its own mini-cascade, once per open — and the body is never blank.** From the dialog's first painted frame, its content is present in ghost form (rule 5); header + title lead, sections ghost-in top→bottom. Then rules A2–A8 apply at half scale: same stagger token, sweeps capped at 400 ms, total budget 600 ms. Re-opening the same modal on unchanged data may skip the replay.

#### E. Guard-rails (all of the above)

17. **`prefers-reduced-motion` collapses everything.** Cascade, sweeps, count-ups, and slides all resolve instantly to final state under the existing global reduced-motion block. Count-up implementations must render the final number, not freeze mid-count.
18. **Cheap properties only, no residue.** All choreography animates `opacity` and `transform` (compositor) or `clip-path` for draw-ons (paint-cheap at meter/chart sizes; not compositor-accelerated in Safari/Firefox — keep clipped areas small). No `width`/`height`/`top`/`left`/`margin` *animation*; the one sanctioned exception is the meter's base `transition: width` for **post-entrance value deltas**, so a real data change tweens between real values instead of jumping. **Authoring model**: base styles are the *final* state, the hidden state lives in explicit `from` keyframes, and entrances use `animation-fill-mode: backwards` — after `animationend`, computed styles return to base, leaving no permanent transform (which would silently become a containing block for `position: fixed` descendants) and no pinned clip-path. Table rows animate **opacity only** (`.row-reveal`) — transforms on `<tr>` inside a `border-collapse` table de-collapse borders in WebKit.
19. **Invisible must not be interactive-hostile.** Entrance delays keep elements clickable but unseen; bound that window: table rows cap their cascade at 6 steps on a local 25 ms stagger (worst row visible < 500 ms), and any focused element snaps visible instantly (`:focus-visible`/`:focus-within` → `animation: none`).
20. **Purposeful, not decorative** (restating `docs/11` §2.6 as the tie-breaker): if a proposed animation doesn't communicate *loading order*, *data freshness*, or *cause-and-effect*, it doesn't ship. `--ease-spring` stays out of data surfaces entirely.

### Rejected alternatives

- **Loading spinners / full-page loaders** — communicate "the machine is busy" instead of "here is your page taking shape"; already banned by `docs/11` §2.6, reaffirmed here. The in-button loading state is the sole exception.
- **Uniform shimmer-skeleton everything** — generic grey bars shaped like nothing produce a jarring swap when real content lands and permit layout shift. Data-shaped ghosts (rule 5) keep final geometry and make the reveal continuous.
- **Replaying the cascade on every refetch** — the reference video replays because it's a loop; in a live product, re-animating on TanStack Query revalidation would make passive dashboards feel unstable (rule 12 exists because this is the most tempting mistake).
- **A JS animation-orchestration library (Framer Motion sequencing, GSAP timelines) for the cascade** — the whole choreography is expressible as CSS keyframes + `animation-delay` + two tokens. A timeline library adds bundle weight and a second motion vocabulary for zero additional capability at this complexity. Revisit only if a Phase 3+ surface genuinely needs interruptible/physics motion.
- **Adopting the demo's ~3 s pacing verbatim** — showreel pacing; operators open these screens dozens of times a day. Budget capped at 1 s (rule 4).

### Consequences

- `docs/design/shared/tokens.css` and `packages/web/src/app/globals.css` gain `--stagger-step: 50ms`, `--duration-sweep: 600ms`, and `--duration-exit: 200ms` (the D15 exit); `docs/11-design-identity.md` §2.6 links here.
- Overlay exits use the dedicated `overlay-exit` keyframe (plain fade) — never `animation-direction: reverse` on an entrance keyframe: reverse also reverses the bezier (a declared `--ease-in` renders as `--ease-out`), and it silently breaks if the entrance keyframe ever gains an explicit `from`. Components with a `@starting-style` entrance carry `data-[state=closed]:transition-none` so a close during the entrance hands over to the exit animation instead of compounding.
- Rule A5 is realized by route-level `loading.tsx` ghost states (dashboard + the three list pages), each a data-free server component mirroring its page's final geometry with `.ghost` blocks, `role="status"` + `aria-busy`.
- The existing global `.reveal` utility in `globals.css` (staggered card entrance for the admin finance dashboard, reduced-motion-aware) is the seed implementation of rule A2. Its hardcoded `nth-child` delays (20/60/100/140 ms) and 600 ms duration should migrate to `calc(n * var(--stagger-step))` + `--duration-slow` the next time a surface touches it — no dedicated refactor PR needed.
- Chart components (whatever library lands with the first analytics screen) must support draw-on/sweep entrance, ghost-state rendering, hatched no-data regions, crosshair + tooltip + axis-pill hover, and a controllable (persistable) inspection anchor — this ADR becomes an acceptance criterion for the chart-library choice.
- A `useCountUp` hook (reduced-motion-aware, sweep-synchronised) joins `packages/web/src/hooks/` with the first KPI tile that needs it.
- Reviewers gain concrete red flags: spinner on a content surface, skeleton with wrong geometry, chart container that blanks on filter change, cascade replaying on refetch, `width` animation on a meter.
- Off-state/flagged features are unaffected: choreography only concerns surfaces already visible per the feature-flag rules.

**Reviewer checklist** (any PR touching a loading or data-transition state):
- [ ] Shell/structure static; only content animates (A1)
- [ ] Ghost placeholders match final geometry — zero layout shift (A5–A6)
- [ ] Data draws directionally; count-ups land with the sweep (A7)
- [ ] Filter/tab change keeps the frame mounted — no blank flash (B9)
- [ ] Background refetch does NOT replay the cascade (B12)
- [ ] Chart inspection anchor survives metric/tab switches (C14)
- [ ] Modal body ghosted from first frame; close never re-choreographs the page (D15–D16)
- [ ] `prefers-reduced-motion` yields instant final state incl. count-ups (E17)
- [ ] Only `opacity`/`transform`/`clip-path` animated (E18)

### Revisit criteria

- The chart library chosen for the first analytics screen cannot express the sweep/ghost/hatch grammar → either the library or this ADR must bend, explicitly.
- Operator feedback (or the tenant mobilisation survey) reports the 1 s budget as sluggish on daily-driver screens → lower the budget or scope the cascade to first-visit-per-session.
- A Phase 3+ surface needs interruptible or physics-based motion → reopen the "no JS timeline library" rejection.
