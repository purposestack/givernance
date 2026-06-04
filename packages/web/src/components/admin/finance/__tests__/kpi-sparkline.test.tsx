import { render } from "@testing-library/react";
import { vi } from "vitest";

import { KPISparkline } from "../kpi-sparkline";

vi.mock("recharts", async () => {
  const actual = await vi.importActual<typeof import("recharts")>("recharts");
  const React = await import("react");
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactElement }) =>
      React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
        width: 200,
        height: 30,
      }),
  };
});

describe("KPISparkline", () => {
  it("renders a recharts line within an aria-hidden wrapper by default", () => {
    const { container } = render(
      <KPISparkline
        points={[
          { x: 0, y: 10 },
          { x: 1, y: 6 },
          { x: 2, y: 3 },
        ]}
        color="var(--color-primary)"
      />,
    );
    const wrap = container.querySelector(".kpi-spark");
    expect(wrap).not.toBeNull();
    expect(wrap).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector(".recharts-line")).not.toBeNull();
  });

  it("renders an area layer when fillTint is provided", () => {
    const { container } = render(
      <KPISparkline
        points={[
          { x: 0, y: 10 },
          { x: 1, y: 6 },
          { x: 2, y: 3 },
        ]}
        color="var(--color-primary)"
        fillTint="rgba(8,103,91,0.08)"
      />,
    );
    expect(container.querySelector(".recharts-area")).not.toBeNull();
    expect(container.querySelector(".recharts-line")).not.toBeNull();
  });

  it("exposes role=img when an aria-label is given", () => {
    const { container } = render(
      <KPISparkline
        points={[
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ]}
        color="var(--color-primary)"
        ariaLabel="Sparkline volume"
      />,
    );
    const wrap = container.querySelector(".kpi-spark");
    expect(wrap).toHaveAttribute("role", "img");
    expect(wrap).toHaveAttribute("aria-label", "Sparkline volume");
  });
});
