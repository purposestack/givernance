import { render, screen } from "@testing-library/react";

import { RefundGauge } from "../refund-gauge";

describe("RefundGauge", () => {
  it("renders the gauge with the value-positioned cursor + tick labels", () => {
    const { container } = render(
      <RefundGauge
        valuePercent={0.42}
        thresholds={{ ok: 1, watch: 5, danger: 8 }}
        labels={{
          ariaLabel: "0,42% — zone saine",
          ticks: ["0%", "1%", "5%", "8%"],
        }}
      />,
    );
    expect(screen.getByLabelText("0,42% — zone saine")).toBeInTheDocument();
    for (const tick of ["0%", "1%", "5%", "8%"]) {
      expect(screen.getByText(tick)).toBeInTheDocument();
    }
    // Cursor position is dynamic (Exception 2): value / danger * 100.
    // 0.42 / 8 * 100 = 5.25. The percent now flows through `--cursor-x`
    // on the gauge root (consumed by `.cursor { left: var(--cursor-x) }`
    // in the colocated CSS module).
    const gaugeRoot = container.firstElementChild as HTMLElement;
    expect(gaugeRoot.style.getPropertyValue("--cursor-x")).toBe("5.25%");
  });

  it("clamps to 100 when valuePercent exceeds danger", () => {
    const { container } = render(
      <RefundGauge
        valuePercent={20}
        thresholds={{ ok: 1, watch: 5, danger: 8 }}
        labels={{ ariaLabel: "20% — hors zone", ticks: ["0%", "1%", "5%", "8%"] }}
      />,
    );
    const gaugeRoot = container.firstElementChild as HTMLElement;
    expect(gaugeRoot.style.getPropertyValue("--cursor-x")).toBe("100%");
  });
});
