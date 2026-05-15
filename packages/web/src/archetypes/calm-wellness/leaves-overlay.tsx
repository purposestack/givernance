"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * Falling leaves overlay for Calm Wellness (Epic #362). Pure CSS
 * animation. 22 leaves drift down with rotation + slight horizontal
 * sway over 6 s. `aria-hidden`, pointer-events: none, gated on
 * `prefers-reduced-motion`.
 */
export function FallingLeavesOverlay({ trigger }: { trigger: { x: number; y: number } | null }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!trigger) return;
    setVisible(true);
    const id = setTimeout(() => setVisible(false), 6500);
    return () => clearTimeout(id);
  }, [trigger]);

  const leaves = useMemo(() => {
    return Array.from({ length: 22 }, (_, i) => {
      const left = Math.random() * 100;
      const delay = Math.random() * 1.5;
      const duration = 5 + Math.random() * 2;
      const sway = (Math.random() - 0.5) * 80;
      const rotate = Math.floor(Math.random() * 360);
      const variant = i % 3;
      return { i, left, delay, duration, sway, rotate, variant };
    });
  }, []);

  if (!visible) return null;

  return (
    <div className="calm-leaves" aria-hidden="true">
      {leaves.map((l) => (
        <span
          key={l.i}
          className={`calm-leaf calm-leaf--v${l.variant}`}
          style={
            {
              left: `${l.left}%`,
              animationDelay: `${l.delay}s`,
              animationDuration: `${l.duration}s`,
              "--sway": `${l.sway}px`,
              "--rotate": `${l.rotate}deg`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}
