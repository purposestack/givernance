/**
 * Foundation archetype (Epic #362) — the institutional default.
 *
 * Closest to today's hardcoded layout in
 * `packages/web/src/app/(public)/p/[id]/page.tsx`. Picked as the
 * reference implementation because it lets us validate the slot
 * contract against a design we already know works in production.
 *
 * See `docs/design/donations/public-foundation.html` for the visual
 * reference (Source Serif display + Inter body; side-by-side layout;
 * inline chip-grid amount picker; no easter egg; no ambient motion).
 */

import type { ArchetypeModule } from "../types";
import { FoundationAmountPicker } from "./amount-picker";
import { FoundationFooter } from "./footer";
import { FoundationHero } from "./hero";
import { FoundationProgress } from "./progress";

import "./tokens.css";

const foundation: ArchetypeModule = {
  key: "foundation",
  layout: "side-by-side",
  Hero: FoundationHero,
  Progress: FoundationProgress,
  AmountPicker: FoundationAmountPicker,
  Footer: FoundationFooter,
  motion: { ambient: "none", easterEgg: null },
};

export default foundation;
