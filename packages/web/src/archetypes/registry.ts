/**
 * The closed `ARCHETYPES` registry (Epic #362, ADR-030 § Decision).
 *
 * Every entry is a `() => Promise<ArchetypeModule>` so the archetype
 * bundle is lazy-loaded by `import()` only when its key is selected.
 * A tenant on `foundation` ships ~0 KB of `cosmic-gradient` code.
 *
 * **DO NOT** rewrite this as a template-literal dynamic import
 * (`import(\`./${key}/index.ts\`)`) — Webpack/Turbopack expand the
 * prefix into "anything under `./`", which widens the attack surface
 * to any value `publicPageStyle` could carry. The closed `Record` is
 * the structural fix: an unknown key fails the TypeScript check
 * before reaching the loader. The Rejected alternatives table in
 * ADR-030 spells out why.
 *
 * **Phase 4 follow-up plan**: 3 archetypes ship implementations in
 * PR-4 (Foundation = institutional default; Activist = recurring-
 * mobilisation; Cosmic Gradient = motion-heavy canary). The other 7
 * land in PR-4b–d as they're designed against the live picker UI
 * (the slot contract is already proven by ADR-030 § Slot Inventory).
 *
 * Each missing archetype falls back to the Foundation slot bundle
 * via the `ArchetypeLoader` in `../app/(public)/p/[id]/page.tsx`
 * (PR-4 follow-up wiring) so the donor page never renders broken
 * even if a tenant manages to pick an un-implemented archetype.
 *
 * **Operator-experience foot-gun** (PR-4 review): an unimplemented
 * archetype silently downgrades to Foundation. URL doesn't change,
 * no banner appears, no operator-side signal. The picker UI in PR-3
 * (`PublicPageStylePicker`) currently lets the operator pick any of
 * the 10 archetypes; PR-4b must add either:
 *   (a) a "Coming soon — currently renders as Foundation" label on
 *       un-shipped tiles in the picker, OR
 *   (b) a per-tile feature-flag (`donation.public_page_styles.<key>`)
 *       that hides un-shipped tiles entirely.
 * The current posture is acceptable as a defence-in-depth fallback
 * but operator-confusing if it's the ONLY signal.
 */

import type { PublicPageStyleKey } from "@givernance/shared/constants";
import type { ArchetypeModule } from "./types";

export const ARCHETYPES: Record<PublicPageStyleKey, () => Promise<ArchetypeModule>> = {
  // ─── Implemented (PR-4 + PR-6) ─────────────────────────────────────────
  foundation: () => import("./foundation").then((m) => m.default),
  activist: () => import("./activist").then((m) => m.default),
  "calm-wellness": () => import("./calm-wellness").then((m) => m.default),
  "cosmic-gradient": () => import("./cosmic-gradient").then((m) => m.default),

  // ─── Awaiting implementation — falls back to Foundation ────────────────
  // The PR-4 review's "silent-downgrade foot-gun" applies here. The
  // picker UI marks these "Coming soon" via `IMPLEMENTED_ARCHETYPE_KEYS`
  // below so the operator-side signal is clear.
  "editorial-story": () => import("./foundation").then((m) => m.default),
  "minimal-checkout": () => import("./foundation").then((m) => m.default),
  "emergency-appeal": () => import("./foundation").then((m) => m.default),
  "neo-brutalist": () => import("./foundation").then((m) => m.default),
  "civic-modern": () => import("./foundation").then((m) => m.default),
  "retro-print": () => import("./foundation").then((m) => m.default),
};

/**
 * The subset of `PUBLIC_PAGE_STYLE_KEYS` with a real React
 * implementation today. The campaign-editor picker reads this to
 * render "Coming soon" badges on un-implemented tiles — no donor
 * surprises, no operator confusion when their pick renders as
 * Foundation.
 */
export const IMPLEMENTED_ARCHETYPE_KEYS: ReadonlySet<PublicPageStyleKey> = new Set([
  "foundation",
  "activist",
  "calm-wellness",
  "cosmic-gradient",
]);
