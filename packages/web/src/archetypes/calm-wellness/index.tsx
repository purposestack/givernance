/**
 * Calm Wellness archetype (Epic #362) — soft pastel washes, lowercase
 * headlines, breath-paced. Motion canary alongside Cosmic Gradient.
 *
 * Visual reference: `docs/design/donations/public-calm-wellness.html`.
 *
 * `layout = side-by-side`, `ambient motion = reduced-ok` (24 s mesh
 * drift; halts on `prefers-reduced-motion: reduce`). Easter egg:
 * click the headline 5 times within 2 s → falling leaves.
 */

import type { ArchetypeModule } from "../types";
import { CalmAmountPicker } from "./amount-picker";
import { CalmFooter } from "./footer";
import { CalmHero } from "./hero";
import { FallingLeavesOverlay } from "./leaves-overlay";
import { CalmProgress } from "./progress";

import "./tokens.css";

const calmWellness: ArchetypeModule = {
  key: "calm-wellness",
  layout: "side-by-side",
  Hero: CalmHero,
  Progress: CalmProgress,
  AmountPicker: CalmAmountPicker,
  Footer: CalmFooter,
  motion: {
    ambient: "reduced-ok",
    easterEgg: {
      description: "Click headline 5 times within 2 s → falling leaves",
      trigger: { kind: "click-count", targetClass: "calm-hero__title", count: 5, resetMs: 2000 },
      Render: FallingLeavesOverlay,
    },
  },
};

export default calmWellness;
