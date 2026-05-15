"use client";

/**
 * `useEasterEgg(spec, callback)` — the only authorised path for
 * archetype-bundled easter eggs (Epic #362, ADR-030 § Motion policy).
 *
 * The hook is the choke point that:
 *   - Short-circuits to no-op under `prefers-reduced-motion: reduce`,
 *     `prefers-reduced-data: reduce`, or
 *     `navigator.connection?.saveData === true`. Archetypes CANNOT
 *     bypass this — it's enforced here, once.
 *   - NEVER logs, persists, or POSTs the listener input (keystrokes,
 *     click coordinates) — only the boolean trigger result is
 *     observed by the callback. Donor input on a public page is a
 *     GDPR-adjacent risk and the hook is the choke point.
 *   - Limits side-effects to `aria-hidden` visual artefacts; the
 *     `EasterEggSpec.Render` contract is enforced at type-time by
 *     requiring an `aria-hidden` overlay component.
 *
 * The hook returns:
 *   - `trigger`: `{ x, y } | null` — when non-null, the egg has just
 *     fired and the archetype should render its overlay at the
 *     specified coordinates (relevant for `click-region` and
 *     `click-count`; `null` coordinates for keyboard sequences).
 *   - `reset()`: clear the trigger so the egg can fire again.
 *
 * The hook does NOT render anything itself — composition with the
 * `EasterEggSpec.Render` component is the archetype's job, gated on
 * `trigger !== null`.
 */

import { useCallback, useEffect, useState } from "react";
import type { EasterEggSpec } from "./types";

interface EasterEggResult {
  trigger: { x: number; y: number } | null;
  reset: () => void;
}

const KONAMI_SEQUENCE = [
  "ArrowUp",
  "ArrowUp",
  "ArrowDown",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "ArrowLeft",
  "ArrowRight",
  "b",
  "a",
] as const;

export function useEasterEgg(spec: EasterEggSpec | null): EasterEggResult {
  const [trigger, setTrigger] = useState<{ x: number; y: number } | null>(null);

  const reset = useCallback(() => setTrigger(null), []);

  useEffect(() => {
    if (!spec) return;

    // The user-preference / data-saver checks are the load-bearing
    // a11y/GDPR-adjacent guards from ADR-030 § Motion policy. Read
    // them via `matchMedia` so a user toggling reduced-motion mid-
    // session takes effect on the next listener tick (no manual
    // re-subscribe needed; the listeners just stop firing the
    // callback).
    const isMotionReduced = () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const isDataReduced = () => {
      if (typeof window === "undefined") return false;
      if (window.matchMedia("(prefers-reduced-data: reduce)").matches) return true;
      // `navigator.connection` is the non-standard WICG Network
      // Information API — widely supported in EU mobile browsers
      // (Chrome on Android, Samsung Internet, Free Mobile FR). Typed
      // shim avoids `any` per CLAUDE.md memory `feedback_warnings_become_errors`.
      const nav = navigator as Navigator & { connection?: { saveData?: boolean } };
      return nav.connection?.saveData === true;
    };
    const isMuted = () => isMotionReduced() || isDataReduced();

    const fire = (x: number, y: number) => {
      if (isMuted()) return;
      setTrigger({ x, y });
    };

    // Keyboard-sequence triggers (konami).
    if (spec.trigger.kind === "konami") {
      let progress = 0;
      const onKey = (e: KeyboardEvent) => {
        const expected = KONAMI_SEQUENCE[progress];
        // Case-insensitive match for the trailing "b", "a".
        const actual = e.key.length === 1 ? e.key.toLowerCase() : e.key;
        if (actual === expected) {
          progress += 1;
          if (progress === KONAMI_SEQUENCE.length) {
            progress = 0;
            fire(window.innerWidth / 2, window.innerHeight / 2);
          }
        } else {
          progress = actual === KONAMI_SEQUENCE[0] ? 1 : 0;
        }
      };
      window.addEventListener("keydown", onKey);
      return () => window.removeEventListener("keydown", onKey);
    }

    // Click-region / triple-click / click-count / hover-and-hold all
    // attach to a class-selected target via delegated listening on
    // document. This keeps each archetype's HTML simple — no ref
    // wiring required — and the listeners detach cleanly on unmount.
    const targetClass =
      spec.trigger.kind === "click-region" ||
      spec.trigger.kind === "click-count" ||
      spec.trigger.kind === "hover-and-hold" ||
      spec.trigger.kind === "triple-click"
        ? spec.trigger.targetClass
        : "";

    if (spec.trigger.kind === "click-region") {
      const onClick = (e: MouseEvent) => {
        const target = e.target as Element | null;
        if (!target?.closest(`.${targetClass}`)) return;
        fire(e.clientX, e.clientY);
      };
      document.addEventListener("click", onClick);
      return () => document.removeEventListener("click", onClick);
    }

    if (spec.trigger.kind === "click-count") {
      let count = 0;
      let resetTimer: ReturnType<typeof setTimeout> | null = null;
      const { count: needed, resetMs } = spec.trigger;
      const onClick = (e: MouseEvent) => {
        const target = e.target as Element | null;
        if (!target?.closest(`.${targetClass}`)) return;
        count += 1;
        if (resetTimer) clearTimeout(resetTimer);
        if (count >= needed) {
          count = 0;
          fire(e.clientX, e.clientY);
        } else {
          resetTimer = setTimeout(() => {
            count = 0;
          }, resetMs);
        }
      };
      document.addEventListener("click", onClick);
      return () => {
        document.removeEventListener("click", onClick);
        if (resetTimer) clearTimeout(resetTimer);
      };
    }

    if (spec.trigger.kind === "triple-click") {
      const onClick = (e: MouseEvent) => {
        if (e.detail !== 3) return;
        const target = e.target as Element | null;
        if (!target?.closest(`.${targetClass}`)) return;
        fire(e.clientX, e.clientY);
      };
      document.addEventListener("click", onClick);
      return () => document.removeEventListener("click", onClick);
    }

    if (spec.trigger.kind === "hover-and-hold") {
      // `mouseover`/`mouseout` bubble, so naively re-arming on every
      // descendant crossing both leaks timers AND cancels the in-
      // flight hold the moment the pointer crosses any internal
      // boundary (PR-4 review, IMPORTANT race-condition). Fix:
      //   - ignore re-arms while a timer is already armed
      //   - on mouseout, only cancel if the pointer actually left
      //     the target subtree (relatedTarget outside `.targetClass`)
      const { durationMs } = spec.trigger;
      let holdTimer: ReturnType<typeof setTimeout> | null = null;
      const onMouseOver = (e: MouseEvent) => {
        const target = e.target as Element | null;
        if (!target?.closest(`.${targetClass}`)) return;
        if (holdTimer) return; // already arming, suppress bubble re-fires
        holdTimer = setTimeout(() => {
          fire(e.clientX, e.clientY);
          holdTimer = null;
        }, durationMs);
      };
      const onMouseOut = (e: MouseEvent) => {
        if (!holdTimer) return;
        const related = e.relatedTarget as Element | null;
        // Pointer still inside the target subtree → not a real leave.
        if (related?.closest(`.${targetClass}`)) return;
        clearTimeout(holdTimer);
        holdTimer = null;
      };
      document.addEventListener("mouseover", onMouseOver);
      document.addEventListener("mouseout", onMouseOut);
      return () => {
        document.removeEventListener("mouseover", onMouseOver);
        document.removeEventListener("mouseout", onMouseOut);
        if (holdTimer) clearTimeout(holdTimer);
      };
    }
  }, [spec]);

  return { trigger, reset };
}
