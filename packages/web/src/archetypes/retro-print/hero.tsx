"use client";

import { EasterEgg } from "../easter-egg";
import type { HeroSlotProps } from "../types";
import { BloomOverlay } from "./bloom-overlay";

/**
 * Retro Print `Hero` — riso-red slab with tilted blue stamp. Easter
 * egg: hover-and-hold the stamp for 800 ms → ink-bloom overlay.
 */
export function RetroHero({ data }: HeroSlotProps) {
  return (
    <div className="retro-hero">
      <span className="retro-hero__stamp">Stamped · 2026</span>
      {data.organisationName ? (
        <p className="retro-hero__eyebrow">{data.organisationName}</p>
      ) : null}
      {data.title ? <h1 className="retro-hero__title">{data.title}</h1> : null}
      {data.description ? <p className="retro-hero__lede">{data.description}</p> : null}
      <EasterEgg
        spec={{
          description: "Hover-and-hold the stamp → ink bloom",
          trigger: { kind: "hover-and-hold", targetClass: "retro-hero__stamp", durationMs: 800 },
          Render: BloomOverlay,
        }}
      />
    </div>
  );
}
