/**
 * Activist archetype (Epic #362) — sustained mobilisation, recurring-
 * first. Big colour saturation, oversized headline, counter strip.
 *
 * Visual reference: `docs/design/donations/public-activist.html`.
 *
 * Easter egg: Konami code → confetti rain in the brand colour for 4 s.
 * Declared in-place inside the Hero via `useEasterEgg`; respects
 * `prefers-reduced-motion` / `prefers-reduced-data` / `saveData`.
 */

import type { ArchetypeModule } from "../types";
import { ActivistAmountPicker } from "./amount-picker";
import { ActivistFooter } from "./footer";
import { ActivistHero } from "./hero";
import { ActivistProgress } from "./progress";

// Tokens load with the archetype's chunk; the file lives next to the
// components so Webpack/Turbopack treats it as a CSS module sibling
// of the lazy-imported JS.
import "./tokens.css";

const activist: ArchetypeModule = {
  key: "activist",
  Hero: ActivistHero,
  Progress: ActivistProgress,
  AmountPicker: ActivistAmountPicker,
  Footer: ActivistFooter,
};

export default activist;
