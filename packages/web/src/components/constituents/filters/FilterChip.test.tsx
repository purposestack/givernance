import { fireEvent, render, screen } from "@testing-library/react";
import { FilterChip } from "./FilterChip";
import type { FilterChipData } from "./filter-types";

describe("FilterChip", () => {
  const mockFilter: FilterChipData = {
    id: "test-1",
    label: "City",
    field: "address.city",
    operator: "eq",
    value: "Geneva",
  };

  it("renders filter information correctly", () => {
    render(<FilterChip filter={mockFilter} />);

    expect(screen.getByText("City")).toBeInTheDocument();
    expect(screen.getByText("equals")).toBeInTheDocument();
    expect(screen.getByText("Geneva")).toBeInTheDocument();
  });

  it("renders date range correctly", () => {
    const dateFilter: FilterChipData = {
      id: "test-2",
      label: "Last donation",
      field: "donations.lastDate",
      operator: "between",
      value: ["2024-01-01", "2024-12-31"],
    };

    render(<FilterChip filter={dateFilter} />);

    expect(screen.getByText("Last donation")).toBeInTheDocument();
    expect(screen.getByText("between")).toBeInTheDocument();
    // Date formatting depends on locale
    expect(screen.getByText(/2024/)).toBeInTheDocument();
  });

  it("renders boolean value correctly", () => {
    const boolFilter: FilterChipData = {
      id: "test-3",
      label: "Recurring donor",
      field: "donations.recurring",
      operator: "eq",
      value: true,
    };

    render(<FilterChip filter={boolFilter} />);

    expect(screen.getByText("Recurring donor")).toBeInTheDocument();
    expect(screen.getByText("Yes")).toBeInTheDocument();
  });

  it("calls onRemove when close button clicked", () => {
    const onRemove = vi.fn();
    render(<FilterChip filter={mockFilter} onRemove={onRemove} />);

    const removeButton = screen.getByRole("button", { name: /remove/i });
    fireEvent.click(removeButton);

    expect(onRemove).toHaveBeenCalledWith("test-1");
  });

  it("does not render remove button when removable is false", () => {
    const nonRemovableFilter = { ...mockFilter, removable: false };
    render(<FilterChip filter={nonRemovableFilter} onRemove={vi.fn()} />);

    expect(screen.queryByRole("button", { name: /remove/i })).not.toBeInTheDocument();
  });

  it("renders an already-resolved pattern label verbatim without translating it", () => {
    // Regression: campaign-members-card resolves pattern labels
    // (`patterns.recurring` → "Donateurs récurrents") before building the
    // chip, so FilterChip receives the literal a SECOND time. It must NOT
    // try to translate the literal as a key — next-intl 4.x reports the
    // miss via onError (a MISSING_MESSAGE console error / dev overlay),
    // which fired once per pattern chip. The label must render unchanged.
    const patternFilter: FilterChipData = {
      id: "pattern-1",
      kind: "pattern",
      label: "Donateurs récurrents",
      field: "",
      operator: "eq",
      value: true,
      pattern: "RECURRING",
    };

    render(<FilterChip filter={patternFilter} />);

    expect(screen.getByText("Donateurs récurrents")).toBeInTheDocument();
  });
});
