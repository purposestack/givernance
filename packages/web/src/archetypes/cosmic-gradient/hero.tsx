"use client";

import { EasterEgg } from "../easter-egg";
import type { HeroSlotProps } from "../types";
import { ParticleOverlay } from "./particle-overlay";

/**
 * Cosmic Gradient `Hero` — animated mesh, gradient text-fill on the
 * title, glassmorphism throughout. Easter egg attaches to
 * `.cosmic-hero__mesh` so any click on the gradient region spawns a
 * particle burst.
 */
export function CosmicHero({ data }: HeroSlotProps) {
  return (
    <div className="cosmic-hero">
      <div className="cosmic-hero__mesh" aria-hidden="true" />
      <div className="cosmic-hero__content">
        <p className="cosmic-hero__eyebrow">★ {data.organisationName || "Public donation"}</p>
        <h1 className="cosmic-hero__title">{data.title}</h1>
        {data.description ? <p className="cosmic-hero__lede">{data.description}</p> : null}
      </div>
      <EasterEgg
        spec={{
          description: "Click hero gradient → particle burst",
          trigger: { kind: "click-region", targetClass: "cosmic-hero__mesh" },
          Render: ParticleOverlay,
        }}
      />
    </div>
  );
}
