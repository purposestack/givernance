import { render, screen } from "@testing-library/react";

import { SentimentBar } from "../sentiment-bar";

const SEGMENTS = [
  { key: "a", percent: 47, tone: "primary" as const, label: "Très" },
  { key: "b", percent: 34, tone: "tertiary" as const, label: "Plutôt" },
  { key: "c", percent: 19, tone: "neutral" as const, label: "Pas" },
];

describe("SentimentBar", () => {
  it("exposes role='img' + summary aria-label and hides inner segments from SR", () => {
    const summary = "47% très, 34% plutôt, 19% pas";
    const { container } = render(<SentimentBar segments={SEGMENTS} summaryLabel={summary} />);
    const bar = screen.getByRole("img", { name: summary });
    expect(bar).toBeInTheDocument();
    const innerSegs = container.querySelectorAll('[aria-hidden="true"]');
    expect(innerSegs).toHaveLength(3);
  });

  it("hides labels when showLabels=false", () => {
    render(<SentimentBar segments={SEGMENTS} summaryLabel="summary" showLabels={false} />);
    expect(screen.queryByText("47%")).toBeNull();
  });
});
