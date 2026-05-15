/**
 * Neo-Brutalist archetype (Epic #362) — mono type, hard 4px borders,
 * deliberate rotations, neon accents.
 *
 * Visual reference: `docs/design/donations/public-neo-brutalist.html`.
 * For arts orgs and indie civic groups. Easter egg: triple-click the
 * hero → RGB-shift glitch.
 */

import type { ArchetypeModule } from "../types";
import { NeoBrutalistAmountPicker } from "./amount-picker";
import { NeoBrutalistFooter } from "./footer";
import { NeoBrutalistHero } from "./hero";
import { NeoBrutalistProgress } from "./progress";

import "./tokens.css";

const neoBrutalist: ArchetypeModule = {
  key: "neo-brutalist",
  Hero: NeoBrutalistHero,
  Progress: NeoBrutalistProgress,
  AmountPicker: NeoBrutalistAmountPicker,
  Footer: NeoBrutalistFooter,
};

export default neoBrutalist;
