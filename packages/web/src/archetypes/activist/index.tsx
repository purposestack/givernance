/**
 * Activist archetype (Epic #362) — sustained mobilisation, recurring-
 * first. Big colour saturation, oversized headline, counter strip.
 *
 * Visual reference: `docs/design/donations/public-activist.html`.
 *
 * `layout = side-by-side`, `ambient motion = none`, easter egg =
 * Konami code → confetti rain in the brand colour for 4 s. The
 * easter egg respects `prefers-reduced-motion` / `prefers-reduced-
 * data` / `saveData` via the shared `useEasterEgg` hook.
 */

import type { ArchetypeModule } from "../types";
import { ActivistAmountPicker } from "./amount-picker";
import { ActivistFooter } from "./footer";
import { ActivistHero } from "./hero";
import { ConfettiOverlay } from "./konami-overlay";
import { ActivistProgress } from "./progress";

// Tokens load with the archetype's chunk; the file lives next to the
// components so Webpack/Turbopack treats it as a CSS module sibling
// of the lazy-imported JS.
import "./tokens.css";

const activist: ArchetypeModule = {
  key: "activist",
  layout: "side-by-side",
  Hero: ActivistHero,
  Progress: ActivistProgress,
  AmountPicker: ActivistAmountPicker,
  Footer: ActivistFooter,
  motion: {
    ambient: "none",
    easterEgg: {
      description: "Konami code → confetti rain in brand colour for 4 s",
      trigger: { kind: "konami" },
      Render: ConfettiOverlay,
    },
  },
};

export default activist;
