"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * Particle-burst overlay for Cosmic Gradient (Epic #362). Spawns
 * 28 particles from the click point that drift upward + outward over
 * 1.4 s. CSS-only animation (per ADR-030 § Bundle-size budget) gated
 * on `prefers-reduced-motion`.
 */
export function ParticleOverlay({ trigger }: { trigger: { x: number; y: number } | null }) {
  const [visible, setVisible] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!trigger) return;
    setVisible(trigger);
    const id = setTimeout(() => setVisible(null), 1500);
    return () => clearTimeout(id);
  }, [trigger]);

  // Pre-compute the per-particle vectors so the burst layout doesn't
  // shift on every render (useMemo keyed on visible so a fresh
  // pattern fires per click).
  const particles = useMemo(() => {
    if (!visible) return [];
    return Array.from({ length: 28 }, (_, i) => {
      const angle = (i / 28) * Math.PI * 2 + Math.random() * 0.3;
      const distance = 80 + Math.random() * 80;
      const dx = Math.cos(angle) * distance;
      const dy = Math.sin(angle) * distance - 60;
      const duration = 1.0 + Math.random() * 0.5;
      return { i, dx, dy, duration };
    });
  }, [visible]);

  if (!visible) return null;

  return (
    <div className="cosmic-particle-overlay" aria-hidden="true">
      {particles.map((p) => (
        <span
          key={`${visible.x}-${visible.y}-${p.i}`}
          className="cosmic-particle"
          style={
            {
              left: visible.x,
              top: visible.y,
              "--dx": `${p.dx}px`,
              "--dy": `${p.dy}px`,
              animationDuration: `${p.duration}s`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}
