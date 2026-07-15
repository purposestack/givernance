/**
 * <CountUp /> tests — the KPI count-up wrapper (ADR-035 rule A7 in
 * docs/adrs/adr-035-loading-motion-choreography.md). The load-bearing
 * contract: SSR/no-JS renders the FINAL formatted value (the count from
 * 0 is a client-only, post-hydration enhancement), formatting goes
 * through Intl.NumberFormat with the caller's locale/options, and
 * reduced motion collapses to the final value (rule E17).
 */

import { act } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { render } from "@/tests/test-utils";

import { CountUp } from "./count-up";

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

describe("CountUp", () => {
  it("SSR renders the final formatted value, never 0 (no-JS / hydration contract)", () => {
    const html = renderToString(<CountUp value={1234} locale="en-US" />);
    expect(html).toContain("1,234");
  });

  it("SSR renders currency formatOptions through Intl.NumberFormat", () => {
    const html = renderToString(
      <CountUp
        value={1234.5}
        locale="en-US"
        formatOptions={{ style: "currency", currency: "EUR" }}
      />,
    );
    expect(html).toContain("€1,234.50");
  });

  it("renders the final formatted value immediately under prefers-reduced-motion", () => {
    mockReducedMotion(true);
    const { container } = render(<CountUp value={98765} locale="en-US" />);
    expect(container.textContent).toBe("98,765");
  });

  it("counts up to the final formatted value on the client", () => {
    vi.useFakeTimers({ toFake: ["requestAnimationFrame", "performance"] });
    const { container } = render(<CountUp value={320} locale="en-US" />);
    act(() => {
      vi.advanceTimersByTime(700); // > 600ms sweep window
    });
    expect(container.textContent).toBe("320");
  });

  it("passes className through to the rendered span", () => {
    mockReducedMotion(true);
    const { container } = render(<CountUp value={7} locale="en-US" className="text-3xl" />);
    expect(container.querySelector("span")?.className).toBe("text-3xl");
  });
});
