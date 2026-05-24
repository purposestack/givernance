import { render, screen } from "@testing-library/react";

import { SatMini } from "../sat-mini";

describe("SatMini", () => {
  it("renders the value + unit and optional legacy badge", () => {
    render(<SatMini label="NPS tenants" value="+42" unit="/ 100" legacy="indicateur retardé" />);
    expect(screen.getByText("NPS tenants")).toBeInTheDocument();
    expect(screen.getByText("+42")).toBeInTheDocument();
    expect(screen.getByText("/ 100")).toBeInTheDocument();
    expect(screen.getByText("indicateur retardé")).toBeInTheDocument();
  });

  it("WCAG 1.4.3 — danger tone CTA stays OUTSIDE the is-stale-data wrapper", () => {
    const { container } = render(
      <SatMini
        label="À recontacter"
        value="4"
        unit="tenants"
        tone="danger"
        isStale
        cta={{ label: "Voir la liste", href: "#tenant-health-detractors" }}
      />,
    );
    const stale = container.querySelector(".is-stale-data");
    const cta = screen.getByRole("link", { name: /Voir la liste/ });
    expect(stale).not.toBeNull();
    // The CTA must be a sibling of `.is-stale-data`, not a descendant.
    expect(stale?.contains(cta)).toBe(false);
  });

  it("renders the freshness pip when provided", () => {
    render(
      <SatMini
        label="CSAT support"
        value="4,3"
        unit="/ 5"
        freshness={{
          band: "ok",
          lastCollectedAt: new Date("2026-05-20T00:00:00.000Z"),
          ageDays: 3,
          label: "à jour · 3 j",
        }}
      />,
    );
    expect(screen.getByText(/à jour · 3 j/)).toBeInTheDocument();
  });
});
