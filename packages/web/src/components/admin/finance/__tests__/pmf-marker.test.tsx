import { render } from "@testing-library/react";

import { PMFMarker } from "../pmf-marker";

describe("PMFMarker", () => {
  it("positions the line and tag at thresholdPercent via inline style", () => {
    const { container } = render(<PMFMarker thresholdPercent={40} label="seuil · 40%" />);
    const line = container.querySelector("span");
    expect(line).not.toBeNull();
    // Both line and tag inherit the same `left:40%` — the only sanctioned
    // inline-style use (#440 Exception 2). The value is data, not a class.
    const styled = container.querySelectorAll("[style]");
    for (const el of styled) {
      expect((el as HTMLElement).style.left).toBe("40%");
    }
  });

  it("is aria-hidden — the threshold semantic is carried by the bar's summary label", () => {
    const { container } = render(<PMFMarker thresholdPercent={40} label="seuil · 40%" />);
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
  });
});
