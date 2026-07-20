"use client";

import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * useLayoutEffect on the client so the reset to 0 commits BEFORE paint on
 * client-side navigations (no 1-frame flash of the final value), useEffect
 * during SSR to avoid React's useLayoutEffect-on-the-server warning.
 */
const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export interface UseCountUpOptions {
  /** Animation window in ms — defaults to 600 to sync with --duration-sweep. */
  durationMs?: number;
  /** Set false to skip the animation and render the final value directly. */
  enabled?: boolean;
  /**
   * Ref to the element rendering the number. The hook resolves the nearest
   * entrance-choreography host (`.reveal-item` or a `.cascade` child) and
   * only plays the count-up while that host is still hidden (computed
   * opacity 0) — i.e. while the entrance animation genuinely covers the
   * count from 0. Omitting the ref snaps to `target` (safe default): a
   * number the operator can already see must never re-count from a fake 0.
   */
  hostRef?: RefObject<HTMLElement | null>;
}

/**
 * Count-up from 0 to `target`, synchronised with the ADR-035 data-draw
 * sweep (600 ms) so KPI numbers land together with their chart sweep
 * (rule A7 in docs/adrs/adr-035-loading-motion-choreography.md).
 *
 * - SSR-safe: the initial render returns `target`, so server HTML (and
 *   no-JS clients) show the final number; the count from 0 only starts
 *   client-side — via a pre-paint layout effect, so there is no 1-frame
 *   flash of the final value before the reset to 0.
 * - Anti-fake-counter: the count only plays when `hostRef` resolves to an
 *   entrance-choreography host that is still hidden (opacity 0). Anything
 *   already visible snaps to `target` — animating a value the operator has
 *   already seen reads as data churn, not loading.
 * - Reduced-motion-aware: returns `target` immediately when
 *   `prefers-reduced-motion: reduce` matches (rule E17 — the final
 *   number, never a frozen mid-count).
 * - Plays for the mount-time target only: later `target` changes
 *   (background refetch, TanStack Query revalidation) swap the value in
 *   place without replaying the choreography (rule B12). Under React
 *   Strict Mode the effect→cleanup→effect double-run replays the
 *   animation cleanly instead of latching it off.
 */
export function useCountUp(target: number, opts: UseCountUpOptions = {}): number {
  const { durationMs = 600, enabled = true, hostRef } = opts;
  const [value, setValue] = useState(target);
  const initialTarget = useRef(target);

  useIsoLayoutEffect(() => {
    if (target !== initialTarget.current) {
      // Post-entrance data change: swap in place, never replay (rule B12).
      setValue(target);
      return;
    }

    if (!enabled || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setValue(target);
      return;
    }

    // Anti-fake-counter gate: animate only while the entrance choreography
    // still hides the host. No ref, or an already-visible host → snap.
    const el = hostRef?.current;
    const host = el?.closest(".reveal-item, .cascade > *") ?? el;
    if (!host || getComputedStyle(host).opacity !== "0") {
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
  }, [target, durationMs, enabled, hostRef]);

  return value;
}
