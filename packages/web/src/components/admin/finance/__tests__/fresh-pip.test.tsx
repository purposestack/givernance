import { render, screen } from "@testing-library/react";

import { FreshPip } from "../fresh-pip";

describe("FreshPip", () => {
  it("renders the ok band with the check_circle glyph", () => {
    render(
      <FreshPip
        band="ok"
        lastCollectedAt={new Date("2026-05-21T00:00:00.000Z")}
        ageDays={3}
        label="à jour · 3 j"
      />,
    );
    const pip = screen.getByText(/à jour · 3 j/);
    expect(pip).toHaveClass("fresh-pip", "fresh-pip--ok");
    expect(pip).toHaveAttribute("data-age-days", "3");
  });

  it("renders the stale band with the warning glyph", () => {
    render(
      <FreshPip
        band="stale"
        lastCollectedAt={new Date("2026-01-18T00:00:00.000Z")}
        ageDays={125}
        label="dernière enquête · il y a 125 j"
      />,
    );
    const pip = screen.getByText(/dernière enquête · il y a 125 j/);
    expect(pip).toHaveClass("fresh-pip--stale");
  });
});
