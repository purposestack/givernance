/**
 * Civic Modern archetype (Epic #362) — public-sector neutral, stats-
 * foreground.
 *
 * Visual reference: `docs/design/donations/public-civic-modern.html`.
 * For public universities, museums, libraries, transit-adjacent NPOs.
 * No easter egg — civic neutrality precludes them.
 */

import type { ArchetypeModule } from "../types";
import { CivicAmountPicker } from "./amount-picker";
import { CivicFooter } from "./footer";
import { CivicHero } from "./hero";
import { CivicProgress } from "./progress";

import "./tokens.css";

const civicModern: ArchetypeModule = {
  key: "civic-modern",
  Hero: CivicHero,
  Progress: CivicProgress,
  AmountPicker: CivicAmountPicker,
  Footer: CivicFooter,
};

export default civicModern;
