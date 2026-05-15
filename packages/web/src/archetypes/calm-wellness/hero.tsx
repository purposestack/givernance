"use client";

import type { HeroSlotProps } from "../types";
import { useEasterEgg } from "../use-easter-egg";
import { FallingLeavesOverlay } from "./leaves-overlay";

/**
 * Calm Wellness `Hero` — animated pastel mesh, lowercase headline.
 * Easter egg counts clicks on the headline (5 in 2 s → leaves).
 */
export function CalmHero({ data }: HeroSlotProps) {
  const { trigger } = useEasterEgg({
    description: "Click headline 5× within 2 s → falling leaves",
    trigger: { kind: "click-count", targetClass: "calm-hero__title", count: 5, resetMs: 2000 },
    Render: FallingLeavesOverlay,
  });

  return (
    <div
      className="calm-hero"
      style={{ "--brand-primary": data.colorPrimary } as React.CSSProperties}
    >
      <div className="calm-hero__mesh" aria-hidden="true" />
      <div className="calm-hero__content">
        <p className="calm-hero__eyebrow">
          ✦ {(data.organisationName || "a gentle ask").toLowerCase()}
        </p>
        <h1 className="calm-hero__title">{data.title.toLowerCase()}</h1>
        {data.description ? <p className="calm-hero__lede">{data.description}</p> : null}
      </div>
      <FallingLeavesOverlay trigger={trigger} />
    </div>
  );
}
