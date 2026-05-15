/**
 * Public donation page archetype registry (Epic #362).
 *
 * Single source of truth for the set of visual archetypes — kept in
 * lockstep with the Postgres enum (migration 0054) and the frontend
 * `ARCHETYPES` closed map (ADR-030 § Decision). The integration parity
 * test asserts both halves match.
 *
 * **Ordering** is operator-facing — picker tile order. `Foundation`
 * first as the institutional default; remaining keys grouped by voice
 * quadrant. Don't sort alphabetically.
 *
 * **Naming** is bare kebab-case, no `donation.` prefix — the column
 * lives on `campaigns` / `tenants` and the context is already scoped.
 */

/**
 * Every archetype identifier as a const-tuple literal so the type system
 * keeps it closed: `PublicPageStyleKey` is the discriminated-union type
 * the backend validator + the frontend `ARCHETYPES` map both consume.
 */
export const PUBLIC_PAGE_STYLE_KEYS = [
  "foundation",
  "activist",
  "editorial-story",
  "minimal-checkout",
  "emergency-appeal",
  "neo-brutalist",
  "calm-wellness",
  "civic-modern",
  "retro-print",
  "cosmic-gradient",
] as const;

export type PublicPageStyleKey = (typeof PUBLIC_PAGE_STYLE_KEYS)[number];

/**
 * The hardcoded default when neither the campaign nor the tenant has
 * explicitly picked a style. `Foundation` matches the layout that
 * shipped before Epic #362, so every existing campaign keeps its
 * current look until the operator opts in.
 *
 * Used as the resolution fallback in the API service: `campaign style
 * ?? tenant default ?? DEFAULT_PUBLIC_PAGE_STYLE`.
 */
export const DEFAULT_PUBLIC_PAGE_STYLE: PublicPageStyleKey = "foundation";

/**
 * Operator-facing copy for each archetype. `label` + `tagline` are
 * read by non-technical fundraising managers in the picker — plain
 * language, no jargon, no issue numbers. Engineering notes live in
 * the per-archetype README under `packages/web/src/archetypes/<key>/`.
 */
export interface PublicPageStyleDescriptor {
  key: PublicPageStyleKey;
  /** Short noun phrase shown on the picker tile (≤ 24 chars). */
  label: string;
  /** Single-sentence brief shown under the label (≤ 120 chars). */
  tagline: string;
  /**
   * Voice / posture word for grouping in the picker UX. Used by the
   * picker to render mini-section headers ("Institutional",
   * "Expressive", "Editorial", "Civic"). Keep the set small.
   */
  voice: "institutional" | "expressive" | "editorial" | "minimal" | "civic";
}

export const PUBLIC_PAGE_STYLE_REGISTRY: ReadonlyArray<PublicPageStyleDescriptor> = [
  {
    key: "foundation",
    label: "Foundation",
    tagline: "Restrained institutional look. Donor reads the headline first, the brand second.",
    voice: "institutional",
  },
  {
    key: "activist",
    label: "Activist",
    tagline: "Sustained mobilisation. Recurring-first. Big colour, big type, big ask.",
    voice: "expressive",
  },
  {
    key: "editorial-story",
    label: "Editorial Story",
    tagline: "Long-form photo essay. The donation form reveals after the story.",
    voice: "editorial",
  },
  {
    key: "minimal-checkout",
    label: "Minimal Checkout",
    tagline: "Stripe-Payment-Link grade. No pitch — the donor already trusts you.",
    voice: "minimal",
  },
  {
    key: "emergency-appeal",
    label: "Emergency Appeal",
    tagline: "Counter-led, one-time-first. For disasters and time-bound appeals.",
    voice: "expressive",
  },
  {
    key: "neo-brutalist",
    label: "Neo-Brutalist",
    tagline: "Mono type, hard borders, deliberate roughness. For arts and indie civic orgs.",
    voice: "expressive",
  },
  {
    key: "calm-wellness",
    label: "Calm Wellness",
    tagline: "Soft pastel washes, breath-paced. For mental-health and mindfulness orgs.",
    voice: "expressive",
  },
  {
    key: "civic-modern",
    label: "Civic Modern",
    tagline: "Public-sector neutral. Transparency stats foregrounded.",
    voice: "civic",
  },
  {
    key: "retro-print",
    label: "Retro Print",
    tagline: "Riso-printed energy, two-colour duotone. For heritage and alumni orgs.",
    voice: "editorial",
  },
  {
    key: "cosmic-gradient",
    label: "Cosmic Gradient",
    tagline: "Animated mesh, optimistic, future-facing. For climate-tech and arts orgs.",
    voice: "expressive",
  },
];

/**
 * Runtime predicate: `true` when the input is one of the curated archetype
 * keys. The validator wraps this for the request body; the API service
 * wraps it for the read-path fallback when a stale DB value somehow
 * survives a removed-archetype migration. Defence-in-depth — every read
 * path that returns `publicPageStyle` to a donor MUST verify the value
 * is currently in the registry, because a deprecated archetype removed
 * from the frontend bundle would 404 the donor's page otherwise.
 */
export function isPublicPageStyleKey(value: unknown): value is PublicPageStyleKey {
  return typeof value === "string" && (PUBLIC_PAGE_STYLE_KEYS as readonly string[]).includes(value);
}
