/**
 * Donations list — advanced-filter surface gating
 * (flag `donations.advanced_filters`).
 *
 * Off-state QA contract (CLAUDE.md feature-flag rule): with the flag off the
 * advanced surface is COMPLETELY absent — the search row shows the legacy
 * "More filters" date dialog button, no builder, no chip strip, and a
 * `?filters=` URL param is ignored client-side (the page also never forwards
 * it to the API). With the flag on, the builder button replaces the legacy
 * one and an applied query renders as a removable chip strip.
 */

import { render, screen } from "@testing-library/react";
import type { DataTablePagination } from "@/components/ui/data-table";
import { DonationsTable } from "../donations-table";

// Per-file navigation mock so each test can steer the URL search params
// (the global setup mock always returns an empty URLSearchParams).
const navState = vi.hoisted(() => ({
  params: new URLSearchParams(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/donations",
  useSearchParams: () => navState.params,
}));

const pagination: DataTablePagination = { page: 1, perPage: 20, total: 0, totalPages: 0 };

function renderTable(props: Partial<Parameters<typeof DonationsTable>[0]> = {}) {
  return render(
    <DonationsTable
      donations={[]}
      pagination={pagination}
      canWrite={false}
      canDelete={false}
      sort="donatedAt"
      order="desc"
      dateFrom=""
      dateTo=""
      {...props}
    />,
  );
}

const STATUS_FILTER = JSON.stringify({
  operator: "AND",
  conditions: [{ id: "1", field: "donation.status", operator: "eq", value: "cleared" }],
});

describe("DonationsTable advanced-filter gating", () => {
  beforeEach(() => {
    navState.params = new URLSearchParams();
  });

  it("flag off: legacy button only — no builder, no chip strip", () => {
    renderTable({ advancedFiltersEnabled: false });

    expect(screen.getByRole("button", { name: "More filters" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Advanced filters/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Active filter")).not.toBeInTheDocument();
  });

  it("flag off: a ?filters= URL param renders NO chip strip (surface fully absent)", () => {
    navState.params = new URLSearchParams({ filters: STATUS_FILTER });
    renderTable({ advancedFiltersEnabled: false });

    expect(screen.queryByText("Active filter")).not.toBeInTheDocument();
    expect(screen.queryByText("Status")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More filters" })).toBeInTheDocument();
  });

  it("flag on: builder button replaces the legacy dialog button", () => {
    renderTable({ advancedFiltersEnabled: true });

    expect(screen.getByRole("button", { name: /Advanced filters/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "More filters" })).not.toBeInTheDocument();
    // No applied query → no strip either.
    expect(screen.queryByText("Active filter")).not.toBeInTheDocument();
  });

  it("flag on + applied ?filters=: chip strip renders the localized condition", () => {
    navState.params = new URLSearchParams({ filters: STATUS_FILTER });
    renderTable({ advancedFiltersEnabled: true });

    expect(screen.getByText("Active filter")).toBeInTheDocument();
    // Field label + operator + localized enum value from the donations catalog.
    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("equals")).toBeInTheDocument();
    expect(screen.getByText("Cleared")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear filter" })).toBeInTheDocument();
  });

  it("flag on + legacy ?dateFrom=/?dateTo= URL: chip strip renders with a clear affordance", () => {
    // A bookmarked pre-DSL URL must be clearable in one click — the legacy
    // params render through the same strip as an applied DSL query.
    renderTable({ advancedFiltersEnabled: true, dateFrom: "2026-01-01", dateTo: "2026-06-30" });

    expect(screen.getByText("Active filter")).toBeInTheDocument();
    expect(screen.getAllByText("Donation date")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Clear filter" })).toBeInTheDocument();
  });

  it("flag off + legacy date params: no strip (legacy dialog owns the surface)", () => {
    renderTable({ advancedFiltersEnabled: false, dateFrom: "2026-01-01", dateTo: "" });

    expect(screen.queryByText("Active filter")).not.toBeInTheDocument();
    // Active date filter appends the "•" badge to the button's accessible name.
    expect(screen.getByRole("button", { name: /More filters/ })).toBeInTheDocument();
  });

  it("flag on + server-rejected filter: inline invalid notice", () => {
    renderTable({ advancedFiltersEnabled: true, advancedFilterInvalid: true });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The filter in this link is invalid and was ignored — the full list is shown.",
    );
  });

  it("flag off: the invalid notice can never render", () => {
    renderTable({ advancedFiltersEnabled: false, advancedFilterInvalid: true });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
