import { fireEvent, render, screen } from "@testing-library/react";
import { FilterChip, resolveValueToken } from "./FilterChip";
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

  it("renders a constituent.type value via the field's i18n option label", () => {
    // Regression (issue #465): the campaign "Constituants liés" chip showed
    // raw "Donor, Beneficiary" instead of the localised labels. The chip must
    // map each value through the field's catalogued option label, not just
    // capitalise the raw enum token.
    const typeFilter: FilterChipData = {
      id: "type-1",
      label: "fields.constituent.type",
      field: "constituent.type",
      operator: "arrayOverlaps",
      value: ["donor", "beneficiary"],
    };

    render(<FilterChip filter={typeFilter} />);

    // English mock messages: option labels resolve to "Donor"/"Beneficiary".
    expect(screen.getByText("Donor, Beneficiary")).toBeInTheDocument();
  });
});

describe("resolveValueToken", () => {
  // A fake French translator proves the OPTION-LABEL path is taken — not the
  // capitalise fallback. The English option labels happen to equal the
  // capitalised tokens, which is exactly why an English-only assertion can't
  // catch the bug and it only surfaced in French.
  const fr = (key: string): string =>
    ({
      "fieldOptions.constituent.type.donor": "Donateur",
      "fieldOptions.constituent.type.beneficiary": "Bénéficiaire",
    })[key] ?? key;

  it("localises a constituent.type token through the field option label", () => {
    expect(resolveValueToken("constituent.type", "donor", fr)).toBe("Donateur");
    expect(resolveValueToken("constituent.type", "beneficiary", fr)).toBe("Bénéficiaire");
  });

  it("falls back to a capitalised token when the field has no catalogued option", () => {
    expect(resolveValueToken("address.city", "donor", fr)).toBe("Donor");
  });

  it("prefers an option-shape object's own label", () => {
    expect(
      resolveValueToken("constituent.type", { value: "donor", label: "Donateur" }, () => "x"),
    ).toBe("Donateur");
  });
});
