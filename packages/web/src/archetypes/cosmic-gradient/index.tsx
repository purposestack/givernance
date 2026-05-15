/**
 * Cosmic Gradient archetype (Epic #362) — animated mesh hero,
 * glassmorphism chips, gradient text-fill. Motion canary alongside
 * Calm Wellness.
 *
 * Visual reference: `docs/design/donations/public-cosmic-gradient.html`.
 *
 * `layout = scroll-reveal`, `ambient motion = reduced-ok` (0.5 Hz
 * gradient mesh; halts on `prefers-reduced-motion: reduce`). Easter
 * egg: click the gradient hero → particle burst.
 */

import type { ArchetypeModule } from "../types";
import { CosmicAmountPicker } from "./amount-picker";
import { CosmicFooter } from "./footer";
import { CosmicHero } from "./hero";
import { ParticleOverlay } from "./particle-overlay";
import { CosmicProgress } from "./progress";

import "./tokens.css";

const cosmicGradient: ArchetypeModule = {
  key: "cosmic-gradient",
  layout: "scroll-reveal",
  Hero: CosmicHero,
  Progress: CosmicProgress,
  AmountPicker: CosmicAmountPicker,
  Footer: CosmicFooter,
  motion: {
    ambient: "reduced-ok",
    easterEgg: {
      description: "Click the gradient hero → particle burst",
      trigger: { kind: "click-region", targetClass: "cosmic-hero__mesh" },
      Render: ParticleOverlay,
    },
  },
};

export default cosmicGradient;
