import { render, screen } from "@testing-library/react";

import { KPITile } from "../kpi-tile";

describe("KPITile", () => {
  it("renders label, value, suffix, delta and foot", () => {
    render(
      <KPITile
        label="Volume des dons"
        value="€1 284 530"
        suffix=",00"
        delta={{ direction: "up", icon: "arrow_upward", label: "+18,2%" }}
        foot="13 080 dons · vs 30 j préc."
        icon="savings"
        iconBg="var(--color-primary-fixed)"
        iconColor="var(--color-on-primary-fixed-variant)"
      />,
    );
    expect(screen.getByText(/Volume des dons/)).toBeInTheDocument();
    expect(screen.getByText("€1 284 530")).toBeInTheDocument();
    expect(screen.getByText(",00")).toBeInTheDocument();
    expect(screen.getByText(/13 080 dons/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("+18,2%");
  });

  it("renders the enrich note when provided", () => {
    render(
      <KPITile
        label="Frais Stripe"
        value="€18 472"
        icon="credit_card"
        iconBg="var(--color-indigo-light)"
        iconColor="var(--color-indigo-text)"
        enrichNote="enrichi depuis le 2026-05-23"
      />,
    );
    expect(screen.getByText("enrichi depuis le 2026-05-23")).toBeInTheDocument();
  });

  it("renders the info tooltip on the label when provided", () => {
    render(
      <KPITile
        label="Revenu Givernance"
        value="€23 192"
        icon="request_quote"
        iconBg="var(--color-tertiary-fixed)"
        iconColor="var(--color-on-tertiary-fixed-variant)"
        infoTooltip="1,5% + 0,30€ par don cleared."
      />,
    );
    expect(screen.getByLabelText("1,5% + 0,30€ par don cleared.")).toBeInTheDocument();
  });
});
