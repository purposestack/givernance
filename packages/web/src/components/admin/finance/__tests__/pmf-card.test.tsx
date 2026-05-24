import { render, screen } from "@testing-library/react";

import { PMFCard, type PMFCardLabels } from "../pmf-card";

const SEGMENTS = [
  { key: "very", percent: 47, tone: "primary" as const, label: "Très déçus" },
  { key: "somewhat", percent: 34, tone: "tertiary" as const, label: "Plutôt déçus" },
  { key: "not", percent: 19, tone: "neutral" as const, label: "Pas déçus" },
];

const COUNTS = [
  { key: "very", label: "Très déçus", count: 18, tone: "primary" as const },
  {
    key: "somewhat",
    label: "Plutôt déçus",
    count: 13,
    tone: "tertiary" as const,
  },
  { key: "not", label: "Pas déçus", count: 7, tone: "neutral" as const },
];

const LABELS: PMFCardLabels = {
  title: "Product-Market Fit",
  infoTooltip: "Sean Ellis.",
  thresholdProse: "tenants très déçus — au-dessus du seuil de fit",
  deltaLabel: "+5 pts vs T-1",
  segmentsSummary: "47% très déçus, 34% plutôt déçus, 19% pas déçus",
  markerLabel: "seuil · 40%",
  staleNote: "Basé sur l'enquête du 18 janv. 2026 — non représentatif",
};

describe("PMFCard", () => {
  it("renders the headline percent + threshold", () => {
    render(
      <PMFCard
        percent={47}
        threshold={40}
        deltaPts={5}
        segments={SEGMENTS}
        counts={COUNTS}
        isStale={false}
        lastCollectedAt={new Date("2026-01-18T00:00:00.000Z")}
        sampleSize={38}
        labels={LABELS}
      />,
    );
    expect(screen.getByText("47")).toBeInTheDocument();
    expect(screen.getByText(/n=38/)).toBeInTheDocument();
    expect(screen.getByLabelText(LABELS.segmentsSummary)).toBeInTheDocument();
  });

  it("WCAG 1.4.3 BLOCKING — isStale dims ONLY the display wrapper, never the card root", () => {
    const { container } = render(
      <PMFCard
        percent={47}
        threshold={40}
        deltaPts={5}
        segments={SEGMENTS}
        counts={COUNTS}
        isStale={true}
        lastCollectedAt={new Date("2026-01-18T00:00:00.000Z")}
        sampleSize={38}
        labels={LABELS}
      />,
    );
    // Root carries data-stale (machine-readable) but NEVER the
    // `is-stale-data` className — that lives on an inner wrapper so
    // sibling actions (e.g. the parent <StaleBanner> buttons) stay at
    // full contrast.
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveAttribute("data-stale", "true");
    expect(root).not.toHaveClass("is-stale-data");
    // The dimming exists on at least one descendant.
    expect(container.querySelector(".is-stale-data")).not.toBeNull();
  });

  it("omits the stale note when isStale=false", () => {
    render(
      <PMFCard
        percent={47}
        threshold={40}
        deltaPts={5}
        segments={SEGMENTS}
        counts={COUNTS}
        isStale={false}
        lastCollectedAt={new Date("2026-01-18T00:00:00.000Z")}
        sampleSize={38}
        labels={LABELS}
      />,
    );
    expect(screen.queryByText(/non représentatif/)).toBeNull();
  });
});
