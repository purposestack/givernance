import { render, screen } from "@testing-library/react";

import { GradeChip } from "../grade-chip";

describe("GradeChip", () => {
  it("renders the A+ grade with the score and synthesized aria-label", () => {
    render(<GradeChip grade="aplus" score={94} />);
    const chip = screen.getByLabelText("A+ · 94/100");
    expect(chip).toHaveClass("grade-chip", "grade-chip--aplus");
    expect(chip).toHaveTextContent("A+");
    expect(chip).toHaveTextContent("94");
  });

  it("renders the D grade with the error palette", () => {
    render(<GradeChip grade="d" score={28} />);
    expect(screen.getByLabelText("D · 28/100")).toHaveClass("grade-chip--d");
  });

  it("honours the display size modifier", () => {
    render(<GradeChip grade="a" score={76} size="display" />);
    expect(screen.getByLabelText("A · 76/100")).toHaveClass("grade-chip--display");
  });
});
