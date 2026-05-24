import { render, screen } from "@testing-library/react";

import { DeltaPill } from "../delta-pill";

describe("DeltaPill", () => {
  it("renders the up variant with synthesized aria-label", () => {
    render(<DeltaPill direction="up" label="+18,2%" icon="arrow_upward" />);
    const pill = screen.getByRole("status");
    expect(pill).toHaveTextContent("+18,2%");
    expect(pill).toHaveClass("delta-pill", "delta-pill--up");
    expect(pill).toHaveAttribute("aria-label", "+18,2%");
  });

  it("renders the cost variant (used for Frais Stripe)", () => {
    render(<DeltaPill direction="cost" label="+18,4%" />);
    expect(screen.getByRole("status")).toHaveClass("delta-pill--cost");
  });

  it("honours a custom aria-label", () => {
    render(<DeltaPill direction="down" label="−6 pts" ariaLabel="Baisse de 6 points" />);
    expect(screen.getByRole("status")).toHaveAttribute("aria-label", "Baisse de 6 points");
  });
});
