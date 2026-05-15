"use client";

import { useEffect, useState } from "react";

/**
 * Brief RGB-shift glitch overlay (~600 ms) for the Neo-Brutalist
 * triple-click easter egg. Auto-removes itself when the animation
 * ends so it never accumulates listeners; no-ops under
 * `prefers-reduced-motion` (gated in `tokens.css`).
 *
 * `aria-hidden` so screen-readers don't surface a meaningless splash.
 */
export function GlitchOverlay({ trigger }: { trigger: { x: number; y: number } | null }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!trigger) return;
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), 620);
    return () => clearTimeout(timer);
  }, [trigger]);

  if (!visible) return null;
  return <div aria-hidden="true" className="neo-glitch-overlay" />;
}
