/**
 * Retro Print archetype (Epic #362) — riso-printed two-colour energy,
 * halftone-dot paper, slight stamp tilts.
 *
 * Visual reference: `docs/design/donations/public-retro-print.html`.
 * For heritage orgs and alumni associations. Easter egg: hover-and-
 * hold the stamp for 800 ms → ink-bloom overlay.
 */

import type { ArchetypeModule } from "../types";
import { RetroAmountPicker } from "./amount-picker";
import { RetroFooter } from "./footer";
import { RetroHero } from "./hero";
import { RetroProgress } from "./progress";

import "./tokens.css";

const retroPrint: ArchetypeModule = {
  key: "retro-print",
  Hero: RetroHero,
  Progress: RetroProgress,
  AmountPicker: RetroAmountPicker,
  Footer: RetroFooter,
};

export default retroPrint;
