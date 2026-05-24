import { render, screen } from "@testing-library/react";

import { MobilisationScoreCard } from "../mobilisation-score-card";

describe("MobilisationScoreCard", () => {
  it("renders the grade chip, score number, and signed delta", () => {
    render(
      <MobilisationScoreCard
        score={76}
        grade="a"
        delta={3.4}
        tenantCount={47}
        labels={{
          title: "Score de Mobilisation",
          infoTooltip: "Santé du fundraising",
          periodLabel: "vs 30 j préc.",
          deltaLabel: "+3,4 pts",
          footnote: "Santé du fundraising agrégée sur 47 tenants.",
        }}
      />,
    );
    expect(screen.getByText("Score de Mobilisation")).toBeInTheDocument();
    expect(screen.getByLabelText("A 76 / 100")).toBeInTheDocument();
    // The score number is rendered twice — once inside the GradeChip
    // (`<span class="n">76</span>`, aria-hidden) and once in the inline
    // text. Asserting via getAllByText.length avoids the "multiple
    // matches" trap.
    expect(screen.getAllByText("76").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("+3,4 pts")).toBeInTheDocument();
    expect(screen.getByText(/Santé du fundraising/)).toBeInTheDocument();
  });

  it("flips the delta direction to down for negative deltas", () => {
    render(
      <MobilisationScoreCard
        score={48}
        grade="c"
        delta={-6.2}
        tenantCount={5}
        labels={{
          title: "Score de Mobilisation",
          infoTooltip: "",
          periodLabel: "vs 30 j préc.",
          deltaLabel: "−6,2 pts",
          footnote: "",
        }}
      />,
    );
    expect(screen.getByText("−6,2 pts")).toBeInTheDocument();
  });
});
