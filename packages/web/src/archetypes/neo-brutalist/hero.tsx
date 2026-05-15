"use client";

import { EasterEgg } from "../easter-egg";
import type { HeroSlotProps } from "../types";
import { GlitchOverlay } from "./glitch-overlay";

/**
 * Neo-Brutalist `Hero` — uppercase mono, italic serif accent, slight
 * CCW rotation. Easter egg: triple-click the hero → RGB-shift glitch.
 */
export function NeoBrutalistHero({ data }: HeroSlotProps) {
  return (
    <div className="neo-hero">
      {data.organisationName ? (
        <p className="neo-hero__eyebrow">— {data.organisationName}</p>
      ) : null}
      {data.title ? <h1 className="neo-hero__title">{data.title}</h1> : null}
      {data.description ? <p className="neo-hero__lede">{data.description}</p> : null}
      <EasterEgg
        spec={{
          description: "Triple-click hero → RGB-shift glitch flash",
          trigger: { kind: "triple-click", targetClass: "neo-hero" },
          Render: GlitchOverlay,
        }}
      />
    </div>
  );
}
