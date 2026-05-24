import { render, screen, within } from "@testing-library/react";

import { TopTenantsList } from "../top-tenants-list";
import type { TenantRow } from "../types";

const ROWS: TenantRow[] = [
  {
    id: "t1",
    name: "Croix-Rouge Française",
    sharePercent: 21.8,
    grade: "aplus",
    score: 94,
    volume: "€280 250",
    commission: "€5 056",
  },
  {
    id: "t2",
    name: "Les Restaurants du Cœur",
    sharePercent: 17.1,
    grade: "a",
    score: 87,
    volume: "€219 240",
    commission: "€3 951",
  },
];

describe("TopTenantsList", () => {
  it("renders the header + a listitem per row with rank, name, grade chip, and volume", () => {
    render(
      <TopTenantsList
        rows={ROWS}
        labels={{
          nameShare: "Tenant · part du volume",
          score: "Score",
          volume: "Volume",
          commissionPrefix: "comm.",
        }}
      />,
    );
    expect(screen.getByText("Tenant · part du volume")).toBeInTheDocument();
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText("Croix-Rouge Française")).toBeInTheDocument();
    expect(within(items[0]!).getByLabelText("A+ · 94/100")).toBeInTheDocument();
    expect(within(items[0]!).getByText("€280 250")).toBeInTheDocument();
    expect(within(items[0]!).getByText(/comm\. €5 056/)).toBeInTheDocument();
  });

  it("falls back href='#' when tenant.href is omitted", () => {
    render(
      <TopTenantsList
        rows={ROWS}
        labels={{ nameShare: "Tenant", score: "Score", volume: "Volume" }}
      />,
    );
    const link = screen.getByRole("link", { name: "Croix-Rouge Française" });
    expect(link).toHaveAttribute("href", "#");
  });
});
