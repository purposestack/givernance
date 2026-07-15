"use client";

import { useEffect, useRef, useState } from "react";

export interface UseCountUpOptions {
  /** Animation window in ms — defaults to 600 to sync with --duration-sweep. */
  durationMs?: number;
  /** Set false to skip the animation and render the final value directly. */
  enabled?: boolean;
}

/**
 * Count-up from 0 to `target`, synchronised with the ADR-035 data-draw
 * sweep (600 ms) so KPI numbers land together with their chart sweep
 * (rule A7 in docs/adrs/adr-035-loading-motion-choreography.md).
 *
 * - SSR-safe: the initial render returns `target`, so server HTML (and
 *   no-JS clients) show the final number; the count from 0 only starts
 *   inside useEffect after hydration — no hydration mismatch.
 * - Reduced-motion-aware: returns `target` immediately when
 *   `prefers-reduced-motion: reduce` matches (rule E17 — the final
 *   number, never a frozen mid-count).
 * - Runs ONCE per mount: later `target` changes (background refetch,
 *   TanStack Query revalidation) swap the value in place without
 *   replaying the choreography (rule B12).
 */
export function useCountUp(target: number, opts: UseCountUpOptions = {}): number {
  const { durationMs = 600, enabled = true } = opts;
  const [value, setValue] = useState(target);
  const hasPlayedRef = useRef(false);

  useEffect(() => {
    if (hasPlayedRef.current) {
      // Post-entrance data change: swap in place, never replay (rule B12).
      setValue(target);
      return;
    }
    hasPlayedRef.current = true;

    if (!enabled || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setValue(target);
      return;
    }

    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const progress = Math.min((now - start) / durationMs, 1);
      // Ease-out cubic — the JS twin of the CSS --ease-out curve.
      const eased = 1 - (1 - progress) ** 3;
      setValue(target * eased);
      if (progress < 1) {
        frame = requestAnimationFrame(tick);
      }
    };
    setValue(0);
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs, enabled]);

  return value;
}
