## ADR-030: Public donation page style archetypes — hybrid shell + slot components

**Status**: Proposed (Epic #362, spike, 2026-05-14)
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

Each archetype contributes three React components via a typed registry:

```ts
type Archetype = {
  key: ArchetypeKey;          // "foundation" | "activist" | …
  Hero: React.ComponentType<HeroSlotProps>;
  AmountPicker: React.ComponentType<AmountSlotProps>;
  Footer: React.ComponentType<FooterSlotProps>;
  tokens: ArchetypeTokens;    // CSS-variable overrides, applied at shell level
  motion?: MotionSpec;        // optional easter-egg + ambient motion config
};
```

The `tokens` block is plain CSS — no JS bundled per archetype. The slot components are lazy-loaded by archetype key:

```ts
const archetypeModule = await import(`@/archetypes/${stylePreset}/index.ts`);
```

This keeps the **non-selected** archetypes out of the donor's bundle entirely. A tenant on `foundation` ships ~0 KB of `cosmic-gradient` code.

### Why not pure-CSS presets (option 1)

The Epic asked us to honestly evaluate this. Three archetypes break the same-tree assumption:

1. **`editorial-story`** needs a scroll-driven layout where the donation form reveals on scroll past the photo essay — that's a different *DOM structure*, not different colours.
2. **`emergency-appeal`** needs the counter to *be* the hero — the amount picker drops below the fold deliberately. Same DOM tree means CSS would have to reorder via `flex order`, which fights screen-readers and tab order.
3. **`minimal-checkout`** *removes* the hero entirely; CSS `display: none` on the hero would still leave it in the accessibility tree and ship its JS.

Forcing a same-tree implementation here would mean either degrading the archetypes (visually equivalent to today's page with different colours, defeating the Epic) or smuggling structural variation behind CSS hacks that break a11y. Rejected.

### Why not full per-archetype pages (option 2)

Three reasons:

1. **Duplication of donation-flow code.** The Stripe Elements + 3DS retry + idempotency-key handling is the most security-sensitive part of the page and has been hardened over multiple PRs (#197, #200, #274, #318). Re-implementing it 10× is a guaranteed regression source.
2. **Branding integration.** The CSS-variable wiring for [Epic #286](https://github.com/purposestack/givernance/issues/286) primary-colour tokens and the `OrgLogo` rendering (with the `unoptimized` Next/Image and fallback `InitialLetterAvatar`) live in one place today. Forking the page 10× means 10 places to keep in sync when [Epic #286](https://github.com/purposestack/givernance/issues/286)'s Phase 2 ships per-campaign hero images.
3. **a11y baseline drift.** Skip-link, landmark order, heading levels, ARIA live regions on the amount picker — these are easy to get wrong differently in each of 10 copies. Owning them in the shell once is the only sustainable posture.

### How the hybrid composes with [Epic #286](https://github.com/purposestack/givernance/issues/286) branding

The shell sets `style={{ "--brand-primary": colorPrimary, "--brand-on-primary": getReadableTextColor(colorPrimary) }}` on the root `<main>`. Every archetype's `tokens` block consumes those variables instead of hard-coding hex. Archetypes can opt to ignore the brand colour (e.g. `retro-print` may force its riso-print palette), but they MUST set `--brand-primary` on the donation-form chrome so the CTA button keeps the operator's brand colour. The `tokens` block is the single seam.

### Bundle-size budget

- Shell + form: ~120 KB gzipped (unchanged from today).
- Each archetype's slot bundle: **target ≤ 8 KB gzipped, hard ceiling 15 KB.** Anything over 15 KB triggers a review — likely a sign the archetype is trying to do too much.
- A donor on `foundation` ships shell + foundation slots. Total: ~125–128 KB gzipped, a ~5 KB regression vs. today, which we accept as the cost of the seam.
- Lazy-loaded via dynamic `import()` keyed on `publicPageStyle` from the API response.

### Visual-regression and a11y testing

Each archetype's slot components get:

- **Playwright screenshot test** — desktop + mobile breakpoints, in both en + fr locales.
- **Lighthouse CI** — mobile Performance ≥ 90, Accessibility ≥ 95.
- **axe-core integration test** — zero violations.

The shell already has these tests today. Adding an archetype adds rows to the test matrix, not new infrastructure.

### Easter eggs

Easter eggs are owned by the archetype's `motion` spec — they're not allowed to reach into the shell. The shell exposes a tiny `useEasterEgg(predicate, callback)` hook that wires up the keyboard / click listeners and **always** short-circuits to no-op when `window.matchMedia('(prefers-reduced-motion: reduce)').matches`. Archetypes can't bypass this — the hook is the only authorised path.

### Feature flag

Per `docs/18-feature-flags.md`, the whole archetype system ships behind `donation.public_page_styles`, default off. With the flag off, the shell ignores `publicPageStyle` entirely and renders today's hardcoded layout — i.e. the existing tenants see no change. The flag flips to "on" per tenant once the org has visited the picker once. (See [Epic #362](https://github.com/purposestack/givernance/issues/362) for the rollout plan.)

### Rejected alternatives

| Alternative | Rejected because |
|---|---|
| **Tailwind utility-only theming** (no slot components — every archetype is a different set of Tailwind classes on the same shell). | The three archetypes above need DOM structural changes, not utility swaps. Picked this for the colour/typography axis (`tokens`), rejected for the structure axis. |
| **CSS-in-JS runtime theming (Stitches, Vanilla Extract).** | Adds a runtime dependency on the donor-facing critical path. The shell uses plain CSS variables + Tailwind v4 `@theme`. |
| **Per-archetype Next.js segment** (`/p/[id]/foundation/page.tsx`, `/p/[id]/activist/page.tsx`). | Forces the URL to leak the archetype, which makes the picker change a redirect rather than a re-render — bad for the donor and bad for SEO. |
| **Server-side switch with hard-coded `if (style === "foundation") return …`** in one big page component. | Doesn't ship; the file grows past comprehension as archetypes are added. |
| **CMS-driven schema** (each archetype is a JSON schema, slots are positions). | Re-invents [Epic #362](https://github.com/purposestack/givernance/issues/362)'s explicit out-of-scope ("no WYSIWYG editor"). |

### Consequences

**Pro:**
- Donor's bundle only carries the chosen archetype.
- Each archetype is one folder (`apps/web/src/archetypes/foundation/`) the design team can iterate on without touching the shell.
- The shell remains the only place to harden the conversion-critical donation flow.
- New archetypes (#11, #12 in 18 months) are additive — no existing-tenant migration needed.
- A future A/B test framework can pick `publicPageStyle` per cohort without re-architecture.

**Con:**
- The "slot contract" needs to be documented and stable — changing it is a breaking change across 10 implementations.
- Code splitting per archetype adds one async chunk per page load; the chunk is cached aggressively but the first donor visit per archetype pays a sub-50 ms request.
- Designers have to think about three slots, not "the whole page" — slight cognitive overhead vs. option 2.

### Revisit if

- We accumulate more than ~3 archetype features that need to reach below the slot interface (e.g. archetype-specific data fetching, archetype-specific Stripe flows). At that point, "shared shell + slots" is no longer earning its keep and we should re-evaluate moving to option 2 with a shared `<DonationCore>` component.
- Lighthouse Performance on mobile dips below 88 on any archetype despite a 15 KB slot budget. That's the signal that the lazy-load orchestration itself is the cost, and we should consider in-bundle all 10 with tree-shakable design tokens.
- We ever ship the WYSIWYG editor (currently OUT of scope). At that point the JSON-schema alternative becomes worth revisiting and the slot interface should accommodate user-provided slot data, not just designer-built components.
