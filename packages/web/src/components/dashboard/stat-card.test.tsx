import { render, screen } from "@testing-library/react";
import { Banknote } from "lucide-react";

import { StatCard } from "./stat-card";

describe("StatCard", () => {
  it("renders label, value, description, period and trend badge", () => {
    render(
      <StatCard
        label="Total collecté"
        value="12 400 €"
        description="Basé sur les derniers dons enregistrés."
        period="Mois en cours (juillet 2026)"
        icon={Banknote}
        trend={{
          value: -6,
          label: "vs mois précédent",
          detail: { current: "94", previous: "100" },
        }}
        cascadeIndex={0}
      />,
    );
    expect(screen.getByText("Total collecté")).toBeInTheDocument();
    expect(screen.getByText("12 400 €")).toBeInTheDocument();
    expect(screen.getByText("Mois en cours (juillet 2026)")).toBeInTheDocument();
    // Trend badge is a tooltip trigger button with an accessible name (issue #229:
    // the delta must explain itself on hover — the aria-label carries the same copy).
    expect(screen.getByRole("button", { name: "-6% — vs mois précédent" })).toBeInTheDocument();
  });

  it("renders a stretched link with the given aria-label when href is set", () => {
    render(
      <StatCard
        label="Donateurs"
        value="128"
        description="3 nouveaux ce mois-ci"
        href="/constituents?types=donor"
        hrefAriaLabel="Ouvrir le rapport détaillé : Donateurs"
        cascadeIndex={2}
      />,
    );
    const link = screen.getByRole("link", { name: "Ouvrir le rapport détaillé : Donateurs" });
    expect(link).toHaveAttribute("href", "/constituents?types=donor");
  });

  it("renders no link when href is absent", () => {
    render(
      <StatCard
        label="Échéances de subventions"
        value="—"
        description="Bientôt"
        cascadeIndex={3}
      />,
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("keeps the trend tooltip trigger above the stretched link (z-10 lift)", () => {
    render(
      <StatCard
        label="Total collecté"
        value="12 400 €"
        description="desc"
        href="/donations"
        trend={{
          value: 4,
          label: "vs mois précédent",
          detail: { current: "104", previous: "100" },
        }}
        cascadeIndex={0}
      />,
    );
    const trigger = screen.getByRole("button", { name: "+4% — vs mois précédent" });
    // Nesting a button inside the anchor would be invalid HTML — the badge
    // must be a sibling lifted above the absolutely-positioned overlay.
    expect(trigger.closest("a")).toBeNull();
    expect(trigger.closest(".z-10")).not.toBeNull();
  });
});
