/**
 * Cosmic Gradient archetype (Epic #362) — animated mesh hero,
 * glassmorphism chips, gradient text-fill. Motion canary alongside
 * Calm Wellness.
 *
 * Visual reference: `docs/design/donations/public-cosmic-gradient.html`.
 *
 * Ambient motion (0.5 Hz gradient mesh) halts on `prefers-reduced-
 * motion: reduce` via a `@media` gate in `tokens.css`. Easter egg:
 * click the gradient hero → particle burst; declared inside the Hero
 * via `useEasterEgg`.
 */

import type { ArchetypeModule } from "../types";
import { CosmicAmountPicker } from "./amount-picker";
import { CosmicFooter } from "./footer";
import { CosmicHero } from "./hero";
import { CosmicProgress } from "./progress";

import "./tokens.css";

const cosmicGradient: ArchetypeModule = {
  key: "cosmic-gradient",
  Hero: CosmicHero,
  Progress: CosmicProgress,
  AmountPicker: CosmicAmountPicker,
  Footer: CosmicFooter,
};

export default cosmicGradient;
