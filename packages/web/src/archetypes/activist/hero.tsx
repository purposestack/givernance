"use client";

import type { HeroSlotProps } from "../types";
import { useEasterEgg } from "../use-easter-egg";
import { ConfettiOverlay } from "./konami-overlay";

/**
 * Activist `Hero` — oversized headline on a solid brand-colour panel.
 *
 * Solid background instead of inline `color-mix()` gradient:
 * `color-mix()` silently dropped the whole background declaration in
 * some renderers, leaving white text on a white wrapper = invisible.
 * The activist brand is bold by definition — a single saturated
 * colour is on-brief and bulletproof across browsers.
 */
export function ActivistHero({ data }: HeroSlotProps) {
  const { trigger } = useEasterEgg({
    description: "Konami → confetti rain",
    trigger: { kind: "konami" },
    Render: ConfettiOverlay,
  });

  return (
    <div className="activist-hero">
      <div className="activist-hero__panel" style={{ backgroundColor: data.colorPrimary }}>
        {data.organisationName ? (
          <p className="activist-hero__eyebrow">★ {data.organisationName}</p>
        ) : null}
        {data.title ? <h1 className="activist-hero__title">{data.title}</h1> : null}
        {data.description ? <p className="activist-hero__lede">{data.description}</p> : null}
      </div>
      <ConfettiOverlay trigger={trigger} />
    </div>
  );
}
