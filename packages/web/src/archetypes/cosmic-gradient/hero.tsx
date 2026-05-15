"use client";

import type { HeroSlotProps } from "../types";
import { useEasterEgg } from "../use-easter-egg";
import { ParticleOverlay } from "./particle-overlay";

/**
 * Cosmic Gradient `Hero` — animated mesh, gradient text-fill on the
 * title, glassmorphism throughout. Easter egg attaches to
 * `.cosmic-hero__mesh` so any click on the gradient region spawns a
 * particle burst.
 */
export function CosmicHero({ data }: HeroSlotProps) {
  const { trigger } = useEasterEgg({
    description: "Click hero gradient → particle burst",
    trigger: { kind: "click-region", targetClass: "cosmic-hero__mesh" },
    Render: ParticleOverlay,
  });

  return (
    <div
      className="cosmic-hero"
      style={
        {
          "--brand-primary": data.colorPrimary,
        } as React.CSSProperties
      }
    >
      <div className="cosmic-hero__mesh" aria-hidden="true" />
      <div className="cosmic-hero__content">
        <p className="cosmic-hero__eyebrow">★ {data.organisationName || "Public donation"}</p>
        <h1 className="cosmic-hero__title">{data.title}</h1>
        {data.description ? <p className="cosmic-hero__lede">{data.description}</p> : null}
      </div>
      <ParticleOverlay trigger={trigger} />
    </div>
  );
}
