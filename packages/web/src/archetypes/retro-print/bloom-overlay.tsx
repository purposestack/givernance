"use client";

import { type CSSProperties, useEffect, useState } from "react";

/**
 * Ink-bloom overlay for the Retro-Print hover-and-hold easter egg.
 * Radial duotone bloom centred on the trigger coordinates, ~900 ms
 * lifecycle, auto-removes itself. No-ops under `prefers-reduced-
 * motion` (gated in `tokens.css`).
 */
export function BloomOverlay({ trigger }: { trigger: { x: number; y: number } | null }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!trigger) return;
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), 920);
    return () => clearTimeout(timer);
  }, [trigger]);

  if (!visible || !trigger) return null;
  const style = {
    "--bloom-x": `${trigger.x}px`,
    "--bloom-y": `${trigger.y}px`,
  } as CSSProperties;
  return <div aria-hidden="true" className="retro-bloom-overlay" style={style} />;
}
