/**
 * Slot contract for the public-donation-page archetype system
 * (Epic #362, ADR-030 § Decision).
 *
 * Every archetype exports four React components — `Hero`, `Progress`,
 * `AmountPicker`, `Footer` — plus a `tokens` CSS module + a `motion`
 * spec. The shell (`packages/web/src/app/(public)/p/[id]/page.tsx` in
 * PR-4 follow-up wiring) lazy-imports the archetype's module bundle
 * keyed by `publicPageStyle` and renders the four slots into a
 * shared layout grid.
 *
 * The interface is the **breaking-change surface** — adding a fifth
 * slot is a slot-contract amendment that goes through ADR-030's
 * `Revisit if` clause, not a per-archetype change.
 */

import type { PublicPageStyleKey } from "@givernance/shared/constants";
import type { ComponentType, ReactNode } from "react";

/**
 * Donor-facing payload shape the public-page endpoint returns to the
 * archetype slots. Mirrors `PublishedCampaignPublicPage` from
 * `@/models/public-page` minus the QR-token plumbing that's owned by
 * the shell.
 */
export interface ArchetypePageData {
  campaignId: string;
  title: string;
  description: string | null;
  /** Operator-picked brand colour (Epic #286). The shell pre-sets
   *  `--brand-primary` from this; archetypes opt in via the tokens
   *  CSS rather than re-reading the value at the component level. */
  colorPrimary: string;
  /** Tax-deductible-on-this-currency amount; locale-formatted via the
   *  archetype's tokens or `Intl.NumberFormat` at render. */
  goalAmountCents: number | null;
  raisedCents: number;
  donorCount: number;
  defaultCurrency: "EUR" | "GBP" | "CHF";
  organisationName: string;
  organisationMission: string | null;
  organisationLogoUrl: string | null;
  hasSwissQrBill: boolean;
  /** The resolved archetype after the API's three-layer fallback
   *  (campaign override → tenant default → "foundation"). Never null
   *  when the shell reaches an archetype slot — the shell falls back
   *  to today's hardcoded layout when the API returns null. */
  publicPageStyle: PublicPageStyleKey;
}

/** Props each slot receives. */
export interface HeroSlotProps {
  data: ArchetypePageData;
}
/**
 * Returning `null` from a `Progress` slot is a valid output — used by
 * `emergency-appeal` (counter merged into Hero, per ADR-030 § Slot
 * Inventory) and by archetypes that just hide progress when no goal
 * is configured. The shell expects a `ReactNode | null` from this
 * slot; rendering nothing is the explicit affordance for "this
 * archetype owns its own counter elsewhere."
 */
export interface ProgressSlotProps {
  data: ArchetypePageData;
}
export interface AmountSlotProps {
  data: ArchetypePageData;
  /**
   * The shared `<PublicDonationForm>` client island, pre-built by the
   * shell so the archetype owns the *picker UI* (chip grid layout,
   * recurring-first vs one-time-first ordering, write-in placement)
   * but the Stripe Elements + 3DS handling stays in the shell.
   *
   * `ReactNode` (not a `() => …` callback) because Next.js RSC
   * cannot serialize functions across the server→client boundary —
   * but it CAN serialize a `ReactNode`. The archetype just embeds
   * `{formNode}` wherever its picker UI calls for the form.
   */
  formNode: ReactNode;
}
export interface FooterSlotProps {
  data: ArchetypePageData;
}

/**
 * Layout strategy — shell-controlled grid template. Adding a value
 * here is a slot-contract change (see ADR-030 § Revisit if).
 *
 *   - `side-by-side`: hero + form on a desktop split, stacked on
 *     mobile. (foundation, activist, neo-brutalist, civic-modern,
 *     retro-print, calm-wellness)
 *   - `stacked`: hero on top, form below, single column. (emergency-
 *     appeal, minimal-checkout)
 *   - `scroll-reveal`: hero spans the viewport; the form anchors
 *     after the story and reveals on scroll. (editorial-story,
 *     cosmic-gradient)
 */
export type ArchetypeLayout = "side-by-side" | "stacked" | "scroll-reveal";

/**
 * Ambient motion declaration. Conflating this with the easter-egg
 * hook was rejected in PR-1 review (ADR-030 § Motion policy).
 *
 *   - `none`: archetype CSS contains no `@keyframes` or `animation:`.
 *     Lint-enforced via Stylelint on the archetype CSS file.
 *   - `reduced-ok`: low-amplitude motion that no-ops under
 *     `prefers-reduced-motion: reduce`. The archetype CSS gates its
 *     `@keyframes` on a `[data-motion="reduced"]` attribute the
 *     shell injects.
 *   - `requires-pause-control`: motion >5 s loop (WCAG 2.2.2 level A).
 *     The shell renders a visible "Pause" toggle. NO archetype in
 *     the initial 10-shipset uses this — it exists in the type so
 *     future proposals go through review.
 */
export type AmbientMotion = "none" | "reduced-ok" | "requires-pause-control";

export interface MotionSpec {
  ambient: AmbientMotion;
  /**
   * Optional easter-egg config. `null` for archetypes that intentionally
   * carry no egg (foundation, editorial-story, minimal-checkout,
   * emergency-appeal, civic-modern). The hook short-circuits to no-op
   * under `prefers-reduced-motion`, `prefers-reduced-data`, or
   * `navigator.connection.saveData`.
   */
  easterEgg: EasterEggSpec | null;
}

export interface EasterEggSpec {
  /** Operator-friendly description for QA + the CSM onboarding deck. */
  description: string;
  /**
   * One of the supported trigger kinds — keyboard sequence, click
   * count on a target, hover-and-hold on a class, etc. Add new
   * trigger types via the slot-contract change process.
   */
  trigger:
    | { kind: "konami" }
    | { kind: "click-count"; targetClass: string; count: number; resetMs: number }
    | { kind: "hover-and-hold"; targetClass: string; durationMs: number }
    | { kind: "triple-click"; targetClass: string }
    | { kind: "click-region"; targetClass: string };
  /**
   * Render the egg's animation as an `aria-hidden` overlay appended
   * outside `<main>`. The hook owns the lifecycle (mount + auto-
   * unmount); the archetype owns the visual. NEVER fire `aria-live`,
   * NEVER shift focus, NEVER modify any element's accessible name
   * (ADR-030 § Motion policy).
   */
  Render: ComponentType<{ trigger: { x: number; y: number } | null }>;
}

/**
 * The whole archetype module — one default export per
 * `packages/web/src/archetypes/<key>/index.ts` file. The static
 * `ARCHETYPES` registry in `./registry.ts` is the only place that
 * imports these.
 */
export interface ArchetypeModule {
  key: PublicPageStyleKey;
  layout: ArchetypeLayout;
  Hero: ComponentType<HeroSlotProps>;
  Progress: ComponentType<ProgressSlotProps>;
  AmountPicker: ComponentType<AmountSlotProps>;
  Footer: ComponentType<FooterSlotProps>;
  motion: MotionSpec;
}
