"use client";

import type { EasterEggSpec } from "./types";
import { useEasterEgg } from "./use-easter-egg";

/**
 * Thin wrapper around `useEasterEgg` + the spec's `Render` component.
 *
 * The 3 motion-bearing archetypes (Activist, Calm Wellness, Cosmic
 * Gradient) all repeated the same `const { trigger } = useEasterEgg(...);
 * <Overlay trigger={trigger} />` pattern as siblings of their hero
 * content. Centralising the hook+render pair keeps the structure
 * symmetric across archetypes and removes the per-archetype risk of
 * an author forgetting to wire the overlay component.
 *
 * The overlay always renders (gated by `trigger !== null` inside the
 * spec's Render component), and the hook contract still guarantees
 * `aria-hidden` + no `aria-live` / focus changes per ADR-030 § Motion
 * policy.
 */
export function EasterEgg({ spec }: { spec: EasterEggSpec }) {
  const { trigger } = useEasterEgg(spec);
  const { Render } = spec;
  return <Render trigger={trigger} />;
}
