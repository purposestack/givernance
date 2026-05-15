"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * Confetti rain overlay for the Activist archetype (Epic #362).
 * Pure CSS animation — no `framer-motion` per ADR-030 § Bundle-size
 * budget. The trigger is the `{ x, y } | null` returned by the
 * shared `useEasterEgg` hook (Konami sequence here). When `trigger`
 * goes non-null, we mount the confetti for 4 s then unmount.
 *
 * Reads `--brand-primary` from the closest ancestor with the var
 * set, so the confetti always matches the operator's brand. Falls
 * back to the Activist neon pink in case the variable hasn't been
 * propagated yet.
 *
 * `aria-hidden` + positioned `fixed` so it never affects layout,
 * never announces, never shifts focus (ADR-030 § Motion policy).
 */
export function ConfettiOverlay({ trigger }: { trigger: { x: number; y: number } | null }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!trigger) return;
    setVisible(true);
    const id = setTimeout(() => setVisible(false), 4000);
    return () => clearTimeout(id);
  }, [trigger]);

  // 36 particles is a good density-vs-budget trade — visible without
  // hitting the chunk's 12 KB ceiling once gzipped.
  const particles = useMemo(() => {
    return Array.from({ length: 36 }, (_, i) => {
      const left = Math.random() * 100;
      const delay = Math.random() * 0.8;
      const duration = 2.4 + Math.random() * 1.6;
      const rotate = Math.floor(Math.random() * 360);
      return { i, left, delay, duration, rotate };
    });
  }, []);

  if (!visible) return null;

  return (
    <div className="confetti-overlay" aria-hidden="true">
      {particles.map((p) => (
        <span
          key={p.i}
          className="confetti-overlay__particle"
          style={
            {
              left: `${p.left}%`,
              animationDuration: `${p.duration}s`,
              animationDelay: `${p.delay}s`,
              "--rotate": `${p.rotate}deg`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}
