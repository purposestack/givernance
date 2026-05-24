import { render, screen } from "@testing-library/react";

import { RiskGrid, RiskItem } from "../risk-grid";

describe("RiskGrid", () => {
  it("renders multiple risk items with their badges", () => {
    render(
      <RiskGrid>
        <RiskItem
          label="Concentration"
          value="0,11"
          secondary="HHI · top tenant = 21,8%"
          badge={{ variant: "ok", label: "Bien diversifié", icon: "check_circle" }}
        />
        <RiskItem
          label="Tenants actifs"
          value="41"
          suffix=" / 47"
          secondary="87% actifs · 6 dormants"
          badge={{ variant: "watch", label: "6 à relancer", icon: "visibility" }}
        />
        <RiskItem
          label="Échec paiement"
          value="2,7"
          suffix="%"
          secondary="358 / 13 438 tentatives"
          badge={{ variant: "ok", label: "Sous seuil 8%", icon: "check_circle" }}
        />
      </RiskGrid>,
    );
    expect(screen.getByText("Concentration")).toBeInTheDocument();
    expect(screen.getByText("Bien diversifié")).toBeInTheDocument();
    expect(screen.getByText("6 à relancer")).toBeInTheDocument();
    expect(screen.getByText("Sous seuil 8%")).toBeInTheDocument();
  });

  it("renders the info tooltip on the label", () => {
    render(
      <RiskItem label="Concentration" value="0,11" infoTooltip="HHI sur les parts de volume." />,
    );
    expect(screen.getByLabelText("HHI sur les parts de volume.")).toBeInTheDocument();
  });
});
