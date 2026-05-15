/**
 * Calm Wellness archetype (Epic #362) — soft pastel washes, lowercase
 * headlines, breath-paced. Motion canary alongside Cosmic Gradient.
 *
 * Visual reference: `docs/design/donations/public-calm-wellness.html`.
 *
 * Ambient motion (24 s mesh drift) halts on `prefers-reduced-motion:
 * reduce` via a `@media` gate in `tokens.css`. Easter egg: click the
 * headline 5 times within 2 s → falling leaves; declared inside the
 * Hero via `useEasterEgg`.
 */

import type { ArchetypeModule } from "../types";
import { CalmAmountPicker } from "./amount-picker";
import { CalmFooter } from "./footer";
import { CalmHero } from "./hero";
import { CalmProgress } from "./progress";

import "./tokens.css";

const calmWellness: ArchetypeModule = {
  key: "calm-wellness",
  Hero: CalmHero,
  Progress: CalmProgress,
  AmountPicker: CalmAmountPicker,
  Footer: CalmFooter,
};

export default calmWellness;
