## ADR-030: Public donation page style archetypes — hybrid shell + slot components

**Status**: Proposed (Epic #362, 2026-05-14)
**Related**: ADR-011 (4-layer frontend), ADR-012 (shadcn/ui + design tokens), ADR-013 (frontend type boundary), ADR-023 (bucket topology — `branding` is public-read), `docs/18-feature-flags.md`, `docs/24-branding-assets.md`, `docs/ideas/public-page-styles-teardown.md`

### Context

Per [Epic #362](https://github.com/purposestack/givernance/issues/362), Givernance is adding **10 distinct visual archetypes** the operator can pick from for the public donation page (`/p/[id]`). Today the page is one shared layout; only the primary colour and the logo vary between tenants (Epic #286). The Epic requires the spike to commit to **one** of three architectures:

1. **CSS theme presets** — same React component tree, swap design tokens + a few component variants per archetype.
2. **Alternative React component trees** — route-level template selection; each archetype is its own page component.
3. **Hybrid** — shared shell + per-archetype slot components for the hero, amount picker, and footer.

The decision must be justified against:

- **Bundle-size impact on the public page** — donor-facing critical path. The current `/p/[id]` first-load JS is ~120 KB gzipped. Carrying 10 archetypes in the same bundle multiplies the styling layer.
- **Maintenance cost** — adding archetype #11 in 18 months should be cheap.
- **A/B testability** — even though we explicitly defer multi-variant testing, the architecture shouldn't *prevent* it.
- **Composition with Epic #286 branding tokens** — the operator's primary colour and logo MUST keep working under every archetype.
- **a11y + Lighthouse 90+ mobile** — the public page is the conversion-critical surface; performance regressions are not negotiable.

### Decision

**Hybrid architecture (option 3): a shared `<PublicDonationShell>` that owns layout primitives + a tightly-scoped slot interface for archetype-specific components.**

The shell is the React component tree donors load on `/p/[id]`. It is the source of truth for:

- Data fetching (server component → `CampaignPublicPageService.getPublishedCampaignPublicPage`)
- The `<PublicDonationForm>` client island (Stripe Elements, 3DS post-redirect, idempotency-key wiring) — unchanged across all archetypes
- Skip-to-content link, language switcher, locale-aware footer
- The CSS-variable injection for primary-colour ([Epic #286](https://github.com/purposestack/givernance/issues/286)) tokens
- Postal-QR scan tracking ([Epic #274](https://github.com/purposestack/givernance/issues/274))
- All accessibility scaffolding (landmarks, headings hierarchy, ARIA live regions for the amount picker)

Each archetype contributes four React components via a typed registry:

```ts
type Archetype = {
  key: ArchetypeKey;            // "foundation" | "activist" | …
  Hero: React.ComponentType<HeroSlotProps>;
  Progress: React.ComponentType<ProgressSlotProps>;
  AmountPicker: React.ComponentType<AmountSlotProps>;
  Footer: React.ComponentType<FooterSlotProps>;
  tokens: ArchetypeTokens;      // CSS-variable overrides; tabular-nums required
  motion: MotionSpec;            // ambient + easter-egg motion (mandatory)
  layout: "side-by-side" | "stacked" | "scroll-reveal"; // shell layout strategy
};
```

`Progress` is a fourth slot — separated from `Hero` because three archetypes (`emergency-appeal`, `cosmic-gradient`, `editorial-story`) need the progress counter in radically different positions relative to the rest of the page (hero replacement, post-scroll reveal, footer-anchored). `layout` is a shell-controlled enum, not a per-archetype DOM change — the shell maps the chosen value to one of three pre-tested grid templates, which keeps a11y scaffolding (landmark order, heading hierarchy, tab order) under shell control.

The `tokens` block is plain CSS — no JS bundled per archetype. **Every `tokens` block MUST set `font-variant-numeric: tabular-nums lining-nums`** on the progress counter and amount-chip selectors, so the counter doesn't jitter as the campaign updates and amounts stay aligned across the picker grid.

The slot components are lazy-loaded by archetype key through a **closed static registry** (security: see Rejected alternatives row 6):

```ts
// packages/web/src/archetypes/registry.ts
import type { ArchetypeKey, ArchetypeModule } from "./types";

export const ARCHETYPES: Record<ArchetypeKey, () => Promise<ArchetypeModule>> = {
  foundation:       () => import("./foundation/index.js"),
  activist:         () => import("./activist/index.js"),
  "editorial-story":() => import("./editorial-story/index.js"),
  // … one entry per archetype
};
```

The template-literal form (`await import(\`@/archetypes/${key}/index.ts\`)`) is **prohibited** — Webpack/Turbopack expand the prefix into "anything under `@/archetypes/`", which widens the contract the moment an attacker can influence `key`. The closed `Record` makes unknown values fail at the type-system level before reaching the loader; the `ArchetypeKey` union is the only validator. This keeps non-selected archetypes out of the donor's bundle entirely. A tenant on `foundation` ships ~0 KB of `cosmic-gradient` code.

### Slot inventory — every archetype mapped to the slot contract

A common failure mode for slot-based UI is to discover, three implementations in, that the slot interface doesn't fit one of them. Mapping all 10 archetypes against the four slots + the `layout` enum before merge — and refusing to merge if any archetype breaches:

| Archetype | `layout` | Hero owns | Progress position | Picker mode | Footer style | Ambient motion |
|---|---|---|---|---|---|---|
| `foundation` | side-by-side | logo + headline + mission | inline below hero | inline chip grid + write-in | inst. sig + Givernance attribution | none |
| `activist` | side-by-side | giant headline + tag | inline below hero | 2×2 oversized chips, recurring as second screen | inst. sig + supporters strip | static gradient |
| `editorial-story` | scroll-reveal | full-bleed photo + drop-cap lede | post-scroll reveal | inline below story | inst. sig + author byline | none |
| `minimal-checkout` | stacked | tiny logo, no headline | inline above CTA | the page *is* the picker | inst. sig only | none |
| `emergency-appeal` | stacked | counter IS hero, headline below | hero-replacement | inline below counter | live-launch timestamp | none |
| `neo-brutalist` | side-by-side | type-driven hero, no photo | inline below hero | square chips, hard borders | inst. sig in mono | none |
| `calm-wellness` | side-by-side | lowercase headline + soft wash | inline below hero | pill chips, generous whitespace | inst. sig + breath-paced spacing | low-amplitude SVG morph (≤ 0.1 Hz; reduced-motion: none) |
| `civic-modern` | side-by-side | headline + transparency-stat block | inline below hero | inline chips + recurring + "where does it go?" expander | inst. sig + transparency repeat | none |
| `retro-print` | side-by-side | duotone logo + stamped headline | inline below hero | stamped-postcard chips | inst. sig + faux-print metadata | none |
| `cosmic-gradient` | side-by-side | headline floats over animated mesh | post-scroll reveal | glassmorphism chips | inst. sig + gradient signature | animated gradient mesh (≤ 0.5 Hz; reduced-motion: static) |

No archetype reaches outside the four slots + `layout` enum + tokens + motion contract. If a future archetype proposal needs a fifth slot, the proposal must amend this table and ship the slot-interface change in its own PR before the archetype lands.

### Motion policy — ambient and easter-egg

Easter eggs and ambient motion are **separate concerns** with separate guards. Conflating them, as an earlier draft did, lets an archetype ship a continuously-morphing hero that violates WCAG 2.2.2 (Pause, Stop, Hide — level A) because the easter-egg hook never fires.

**Ambient motion**: any animation that fires without user input (hero gradients, SVG morphs, scroll-driven reveals).

- The shell owns the gate. Every archetype declares `motion.ambient: "none" | "reduced-ok" | "requires-pause-control"`.
- `"none"` (default): no `@keyframes` / `transition`, period. CSS asserts this via a Stylelint rule on the archetype CSS file.
- `"reduced-ok"`: a low-amplitude motion that is safe under `prefers-reduced-motion: no-preference` and **MUST** be no-op under `prefers-reduced-motion: reduce`. The shell injects a `data-motion="reduced"` attribute that the archetype CSS uses to gate its `@keyframes`.
- `"requires-pause-control"`: motion longer than 5 s or louder than `reduced-ok`. The shell **renders a visible "Pause animation" toggle** in the top-right of the hero card. The pause state persists in `localStorage` and re-applies across donor sessions. Currently rejected for the donor-conversion path — no archetype in this Epic uses this value; it exists in the type only to force future proposals through review.

**Easter-egg motion**: user-triggered animations (confetti on Konami code, glitch on hover-and-hold, etc.).

- Owned by the shared `useEasterEgg(predicate, callback)` hook. The hook short-circuits to no-op when **any** of: `prefers-reduced-motion: reduce`, `prefers-reduced-data: reduce`, `navigator.connection?.saveData === true`. The hook is the only authorised path; archetypes can't bypass it.
- Easter-egg side-effects are **visual-only**. No `aria-live` announcement, no focus shift, no DOM injection into the form region, no modification of any element's accessible name during the animation. Egg containers must be `aria-hidden="true"` and appended outside `<main>`.
- The hook MUST NOT log, persist, or POST the listener input (keystrokes, click coordinates) — only the boolean trigger result is observed by the callback. Donor input on a public page is a GDPR-adjacent risk and the hook is the choke point.
- Easter eggs are not discoverable by keyboard for non-keyboard triggers (hover-and-hold, triple-click). This is **not** a WCAG violation: per the teardown, easter eggs are donor-irrelevant decorative artefacts; they carry no information a keyboard user is being denied.

### How the hybrid composes with [Epic #286](https://github.com/purposestack/givernance/issues/286) branding

The shell sets `style={{ "--brand-primary": colorPrimary, "--brand-on-primary": getReadableTextColor(colorPrimary) }}` on the root `<main>`. Every archetype's `tokens` block consumes those variables instead of hard-coding hex. Archetypes can opt to ignore the brand colour (e.g. `retro-print` may force its riso-print palette), but they MUST set `--brand-primary` on the donation-form chrome so the CTA button keeps the operator's brand colour. The `tokens` block is the single seam.

### Bundle-size budget

- Shell + form: ~120 KB gzipped (unchanged from today).
- Each archetype's slot bundle: **target ≤ 8 KB gzipped, hard ceiling 12 KB.** Anything over 12 KB triggers a review — almost always a sign that the archetype is reaching for a motion library it shouldn't.
- A donor on `foundation` ships shell + foundation slots. Total: ~125–128 KB gzipped, a ~5 KB regression vs. today, which we accept as the cost of the seam.
- The motion-heavy archetypes (`calm-wellness`, `cosmic-gradient`) are the Lighthouse-budget canaries — they sit closest to the 12 KB ceiling and worst-case ~80 ms async-chunk RTT on cold load. They're the first to trip the Revisit-if clause below.
- Lazy-loaded via the closed `ARCHETYPES` registry (see § Decision) keyed on `publicPageStyle` from the API response.

**Forbidden in archetype slots** (enforced via Biome `noRestrictedImports` on `packages/web/src/archetypes/**` — see ADR-013 for the boundary pattern):

- `framer-motion`, `motion`, `motion/react` (~14–18 KB gz minimum — busts the budget in one line).
- `gsap`, `@gsap/*` (similar size, plus a license tax).
- `lottie-web`, `lottie-react`, `@lottiefiles/*` (huge runtime, raster decode cost).
- Any general-purpose particle / WebGL library.

**Permitted**: CSS `@keyframes` + `transition`, raw SVG with `<animate>` / `<animateTransform>`, hand-rolled `requestAnimationFrame` loops bounded by `motion.ambient` policy. Hand-rolled is fine; library-shaped motion is not.

### Visual-regression and a11y testing

Each archetype's slot components get:

- **Playwright screenshot test** — desktop + mobile breakpoints, in both en + fr locales.
- **Playwright reduced-motion screenshot** — `emulateMedia({ reducedMotion: 'reduce' })` asserts no `@keyframes` or `animation` style applies to hero/progress elements (catches ambient-motion drift past the slot contract).
- **Lighthouse CI** — mobile Performance ≥ 90, Accessibility ≥ 95.
- **axe-core integration test** — zero violations.
- **Bundle-size assertion** — the archetype's lazy-chunk gzipped size, asserted ≤ 12 KB (hard ceiling, see § Bundle-size budget). Fails CI on regression.

The shell already has these tests today. Adding an archetype adds rows to the test matrix, not new infrastructure.

### Feature flag

Per `docs/18-feature-flags.md`, the whole archetype system ships behind `donation.public_page_styles`, default off. With the flag off, the shell ignores `publicPageStyle` entirely and renders today's hardcoded layout — i.e. existing tenants see no change. **The flag check guards the `ARCHETYPES` registry import itself, not just the call** — so an off-state donor's bundle excludes every archetype chunk from the chunk graph, not just from the runtime execution path.

### Rejected alternatives

| # | Alternative | Rejected because |
|---|---|---|
| 1 | **Pure-CSS / Tailwind utility presets** (option 1 from Epic — every archetype is a different set of utilities on the same DOM tree). | Five of the ten archetypes (`foundation`, `activist`, `civic-modern`, `retro-print`, partial `cosmic-gradient`) could ship CSS-only. The other five force structural divergence — `editorial-story` (post-scroll reveal), `emergency-appeal` (counter-as-hero), `minimal-checkout` (hero removed), `cosmic-gradient` (post-scroll reveal), `calm-wellness` (different progress placement). Forcing CSS-only on those five means either degrading the archetypes (CSS variants of today's page = same project as today, defeats the Epic) or smuggling structure via `flex order` which breaks tab order and screen-reader landmark navigation. Adopting the slot model uniformly across all ten keeps one mental model. |
| 2 | **Full per-archetype pages** (option 2 from Epic — `/p/[id]/foundation/page.tsx`, …). | Three problems: (a) extracting a shared `<DonationCore>` is feasible but recreates the slot contract by accident, with the URL-leakage tax of route segments on top — picker change becomes a 308 redirect rather than a re-render, bad for SEO and donor experience; (b) **a11y baseline drift** — landmark/heading/skip-link/ARIA-live-region scaffolding has to be re-implemented 10 times and *will* drift; (c) [Epic #286](https://github.com/purposestack/givernance/issues/286) Phase 2's per-campaign hero image needs to land in one place, not ten. |
| 3 | **Server-components-only archetypes** (each archetype is a pure-RSC variant of the shell that imports the shared `<PublicDonationForm>` client island). | Genuinely close to the hybrid in shape — kills the dynamic-import chunk overhead — but loses the lazy-load benefit: every archetype's JSX ships in the server bundle even for tenants on `foundation`, so the server roundtrip carries the same bytes as the largest archetype. The client-side hybrid wins on the donor's bytes-on-the-wire, which is the conversion-critical metric. Re-evaluate if mobile JS-parse cost ever dominates over network in our telemetry. |
| 4 | **`shadcn`-style copy-paste archetypes** (each archetype scaffolded *into* the tenant-agnostic codebase rather than dynamically loaded). | Same DX as the hybrid (one folder per archetype) without the runtime registry. Rejected because we explicitly want central control over the catalogue (curated, not customer-modifiable per the Epic's scope statement) and lazy-load. |
| 5 | **MDX-driven / JSON-schema archetypes** (each archetype is content, not code). | Re-invents [Epic #362](https://github.com/purposestack/givernance/issues/362)'s explicit out-of-scope ("no WYSIWYG editor"). |
| 6 | **Template-literal dynamic `import()`** (`import(\`@/archetypes/${stylePreset}/index.ts\`)`). | Webpack/Turbopack expand this to "anything under `@/archetypes/`" at build time. The moment any code path lets `stylePreset` carry a value other than an enum-validated `ArchetypeKey`, the prefix becomes attacker-controllable. The closed `Record<ArchetypeKey, () => Promise<…>>` map (see § Decision) is the structural fix: unknown values fail the type check before reaching the loader. |
| 7 | **Per-route CSS-in-JS theming** (Stitches, Vanilla Extract). | Adds a runtime dependency on the donor-facing critical path. The shell uses plain CSS variables + Tailwind v4 `@theme`. |
| 8 | **Server-side switch with hard-coded `if (style === "foundation") return …`** in one big page component. | Defeats lazy-loading (all 10 archetypes' JSX ships in one server module the bundler can't split) and the file grows past comprehension as archetypes are added. |

### Consequences

**Pro:**
- Donor's bundle only carries the chosen archetype.
- Each archetype is one folder (`apps/web/src/archetypes/foundation/`) the design team can iterate on without touching the shell.
- The shell remains the only place to harden the conversion-critical donation flow.
- New archetypes (#11, #12 in 18 months) are additive — no existing-tenant migration needed.
- A future A/B test framework can pick `publicPageStyle` per cohort without re-architecture.

**Con:**
- The slot contract (Hero / Progress / AmountPicker / Footer + `layout` enum + `motion` spec + `tokens`) needs to be documented and stable — changing it is a breaking change across 10 implementations.
- Code splitting per archetype adds one async chunk per page load; the chunk is cached aggressively but the first donor visit per archetype pays a 50–80 ms request, worst on the motion-heavy archetypes (`calm-wellness`, `cosmic-gradient`).
- Designers have to think about four slots + a layout enum, not "the whole page" — slight cognitive overhead vs. option 2.

### Revisit if

- We accumulate more than ~3 archetype features that need to reach below the slot interface (e.g. archetype-specific data fetching, archetype-specific Stripe flows). At that point, "shared shell + slots" is no longer earning its keep and we should re-evaluate moving to option 2 with a shared `<DonationCore>` component.
- Lighthouse Performance on mobile dips below 88 on any archetype despite the 12 KB slot ceiling. That's the signal that the lazy-load orchestration itself is the cost; in-bundle all 10 with tree-shakable design tokens becomes worth re-evaluating. The motion archetypes (`calm-wellness`, `cosmic-gradient`) are the canaries.
- We ever ship the WYSIWYG editor (currently OUT of scope). At that point the JSON-schema alternative becomes worth revisiting and the slot interface should accommodate user-provided slot data, not just designer-built components.
- An archetype proposal needs a 5th slot. The proposal must amend the Slot Inventory table and ship the slot-interface change in its own PR before the archetype lands — *not* extend the slot type inline with the archetype.
