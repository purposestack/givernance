import { render, screen } from "@testing-library/react";
import { vi } from "vitest";

import { VolumeRevenueChart } from "../volume-revenue-chart";

// recharts' ResponsiveContainer relies on ResizeObserver + measured DOM,
// which jsdom does not provide. Stub it to a fixed-size box so the
// inner ComposedChart actually renders.
// recharts' ResponsiveContainer relies on ResizeObserver + a measured
// parent. In jsdom both are stubbed to 0, so the child chart gets
// width=0/height=0 and bails out of rendering. Replace it with a passthrough
// that clones the child and forces explicit width/height so the inner
// chart materialises.
vi.mock("recharts", async () => {
  const actual = await vi.importActual<typeof import("recharts")>("recharts");
  const React = await import("react");
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactElement }) =>
      React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
        width: 800,
        height: 280,
      }),
  };
});

describe("VolumeRevenueChart", () => {
  const labels = {
    ariaLabel: "Volume et revenu — 30 derniers jours",
    volumeLabel: "Volume",
    revenueLabel: "Revenu",
    formatVolumeTick: (v: number) => `€${Math.round(v / 1000)}k`,
    formatRevenueTick: (v: number) => `€${Math.round(v)}`,
    formatVolume: (v: number) => `€${v.toLocaleString("fr-FR")}`,
    formatRevenue: (v: number) => `€${v.toLocaleString("fr-FR")}`,
  };
  const data = [
    { label: "24 avr", volume: 20000, revenue: 360 },
    { label: "30 avr", volume: 35000, revenue: 630 },
    { label: "9 mai", volume: 52000, revenue: 936 },
    { label: "23 mai", volume: 78000, revenue: 1404 },
  ];

  it("renders the chart wrapper with the aria-label and recharts SVG", () => {
    const { container } = render(
      <VolumeRevenueChart data={data} volumeMax={80000} labels={labels} />,
    );
    expect(screen.getByLabelText("Volume et revenu — 30 derniers jours")).toBeInTheDocument();
    // recharts emits its own SVG with a known root class.
    expect(container.querySelector(".recharts-surface")).not.toBeNull();
    // The Area + Line layers materialise as recharts-{area,line}.
    expect(container.querySelector(".recharts-area")).not.toBeNull();
    expect(container.querySelector(".recharts-line")).not.toBeNull();
  });

  it("returns null on empty data without crashing", () => {
    const { container } = render(<VolumeRevenueChart data={[]} volumeMax={0} labels={labels} />);
    expect(container.firstChild).toBeNull();
  });
});
