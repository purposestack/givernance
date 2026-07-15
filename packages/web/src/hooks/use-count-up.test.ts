/**
 * useCountUp tests — the JS half of the ADR-035 data-draw sweep
 * (docs/adrs/adr-035-loading-motion-choreography.md, rules A7 / B12 /
 * E17): counts 0 → target over the sweep window, runs once per mount,
 * swaps later targets in place, and collapses to the final value under
 * prefers-reduced-motion or enabled=false.
 *
 * requestAnimationFrame + performance are faked so frames advance
 * deterministically via vi.advanceTimersByTime.
 */

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useCountUp } from "./use-count-up";

function useFakeFrames() {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "performance"] });
}

function mockReducedMotion(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

afterEach(() => {
  vi.useRealTimers();
  mockReducedMotion(false);
});

describe("useCountUp", () => {
  it("starts from 0 after mount and lands exactly on target when the sweep completes", () => {
    useFakeFrames();
    const { result } = renderHook(() => useCountUp(320));

    // Mount effect resets to 0 before the first frame (the SSR render
    // itself returns `target`; see the SSR test in count-up.test.tsx).
    expect(result.current).toBe(0);

    act(() => {
      vi.advanceTimersByTime(700); // > 600ms default sweep
    });
    expect(result.current).toBe(320);
  });

  it("is strictly mid-count during the sweep window", () => {
    useFakeFrames();
    const { result } = renderHook(() => useCountUp(1000));

    act(() => {
      vi.advanceTimersByTime(300); // half the 600ms window
    });
    expect(result.current).toBeGreaterThan(0);
    expect(result.current).toBeLessThan(1000);
  });

  it("swaps a post-sweep target change in place without replaying (rule B12)", () => {
    useFakeFrames();
    const { result, rerender } = renderHook(({ target }) => useCountUp(target), {
      initialProps: { target: 320 },
    });

    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(result.current).toBe(320);

    // Background-refetch shape: new target, same mounted hook. The value
    // must jump straight to the new target — never re-count from 0.
    rerender({ target: 480 });
    expect(result.current).toBe(480);
  });

  it("returns the final value immediately when enabled=false", () => {
    useFakeFrames();
    const { result } = renderHook(() => useCountUp(320, { enabled: false }));
    expect(result.current).toBe(320);
  });

  it("returns the final value immediately under prefers-reduced-motion (rule E17)", () => {
    useFakeFrames();
    mockReducedMotion(true);
    const { result } = renderHook(() => useCountUp(320));
    expect(result.current).toBe(320);
  });

  it("respects a custom durationMs window", () => {
    useFakeFrames();
    const { result } = renderHook(() => useCountUp(100, { durationMs: 200 }));

    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(result.current).toBe(100);
  });
});
