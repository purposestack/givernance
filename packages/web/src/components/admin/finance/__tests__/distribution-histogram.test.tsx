import { render, screen } from "@testing-library/react";
import { vi } from "vitest";

import { DistributionHistogram } from "../distribution-histogram";

vi.mock("recharts", async () => {
  const actual = await vi.importActual<typeof import("recharts")>("recharts");
  const React = await import("react");
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactElement }) =>
      React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
        width: 800,
        height: 220,
      }),
  };
});

describe("DistributionHistogram", () => {
  it("renders the chart with the aria-label and recharts bars", () => {
    const { container } = render(
      <DistributionHistogram
        bins={[
          { label: "0-20", count: 1, color: "var(--color-error)", sublabel: "D" },
          { label: "20-30", count: 2, color: "var(--color-tertiary-fixed-dim)" },
          { label: "70-80", count: 12, color: "var(--color-primary-fixed-dim)", sublabel: "A" },
        ]}
        mean={76}
        yMax={12}
        xDomain={[0, 90]}
        labels={{
          ariaLabel: "Distribution des scores",
          meanLabel: "Moy · 76",
          yTicks: ["12", "8", "4", "0"],
        }}
      />,
    );
    expect(screen.getByLabelText("Distribution des scores")).toBeInTheDocument();
    expect(container.querySelector(".recharts-bar")).not.toBeNull();
    expect(container.querySelectorAll(".recharts-rectangle").length).toBeGreaterThanOrEqual(3);
    // ReferenceLine label carries the mean callout text.
    expect(screen.getByText("Moy · 76")).toBeInTheDocument();
  });
});
