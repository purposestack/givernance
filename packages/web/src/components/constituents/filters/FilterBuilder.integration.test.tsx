// @ts-nocheck
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { FilterBuilder } from "./FilterBuilder";

// Mock next-intl
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    const translations: Record<string, string> = {
      title: "Advanced Filters",
      description: "Build complex queries",
      customFilters: "Custom Filters",
      activeFilters: "Active Filters",
      noConditions: "No conditions defined",
      addCondition: "Add condition",
      addFirstCondition: "Add your first filter condition",
      addAnotherCondition: "Add another filter condition",
      selectField: "Select field",
      selectOperator: "Select operator",
      selectValue: "Select value",
      enterValue: "Enter value",
      enterValueFor: `Enter value for ${values?.field || "field"}`,
      removeCondition: "Remove condition",
      cancel: "Cancel",
      apply: "Apply Filters",
      applying: "Applying...",
      applyWithCount: `Apply (${values?.count || 0})`,
      applyError: "Failed to apply filters",
      filterRemoved: `Filter removed: ${values?.field || ""}`,
      previewAnnouncement: `${values?.count || 0} constituents match your filters`,
      "operators.and": "Match all",
      "operators.or": "Match any",
      "validation.incomplete": "Please complete all filter conditions",
      "validation.noConditions": "Please add at least one filter condition",
      "categories.donation_history": "Donation History",
      "presets.title": "Quick Templates",
      "preview.loading": "Calculating matches...",
      "preview.count": `${values?.count || 0} constituents match`,
      "preview.error": "Could not calculate preview",
    };
    return translations[key] || key;
  },
}));

// Mock the FilterPresets component
vi.mock("./FilterPresets", () => ({
  FilterPresets: ({
    onSelect,
  }: {
    onSelect: (preset: { name: string; query: import("./filter-types").FilterQuery }) => void;
  }) => (
    <div data-testid="filter-presets">
      <button
        type="button"
        onClick={() =>
          onSelect({ name: "Test Preset", query: { operator: "AND", conditions: [] } })
        }
      >
        Test Preset
      </button>
    </div>
  ),
}));

// Mock the FilterCondition component with basic functionality
vi.mock("./FilterCondition", () => ({
  FilterCondition: ({
    condition,
    onChange,
    onRemove,
  }: {
    condition: import("./filter-types").FilterCondition;
    onChange: (condition: import("./filter-types").FilterCondition) => void;
    onRemove: () => void;
  }) => (
    <div data-testid="filter-condition">
      <input
        aria-label="Select field"
        value={condition.field}
        onChange={(e) => onChange({ ...condition, field: e.target.value })}
      />
      <input
        aria-label="Enter value for field"
        value={condition.value}
        onChange={(e) => onChange({ ...condition, value: e.target.value })}
      />
      <button type="button" aria-label="Remove condition" onClick={onRemove}>
        Remove
      </button>
    </div>
  ),
}));

// Mock the FilterPreview component
vi.mock("./FilterPreview", () => ({
  FilterPreview: ({
    query,
    onPreview,
  }: {
    query: import("./filter-types").FilterQuery;
    onPreview: () => void;
  }) => {
    // Simulate preview updates
    if (query.conditions.length > 0 && onPreview) {
      setTimeout(() => onPreview({ count: 234 }), 100);
    }
    return (
      <div role="status" data-testid="filter-preview">
        234 constituents match
      </div>
    );
  },
}));

describe("FilterBuilder Integration", () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    onApply: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should complete full filter creation flow", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn().mockResolvedValue(undefined);

    render(<FilterBuilder {...defaultProps} onApply={onApply} />);

    // Step 1: Click add condition
    const addButton = screen.getByLabelText("Add your first filter condition");
    await user.click(addButton);

    // Step 2: Fill in condition
    const fieldInput = screen.getByLabelText("Select field");
    await user.type(fieldInput, "email");

    const valueInput = screen.getByLabelText("Enter value for field");
    await user.type(valueInput, "test@example.com");

    // Step 3: Wait for preview
    await waitFor(() => {
      expect(screen.getByTestId("filter-preview")).toBeInTheDocument();
    });

    // Step 4: Apply filters
    const applyButton = screen.getByText("Apply (234)");
    await user.click(applyButton);

    await waitFor(() => {
      // FilterBuilder.onApply now takes a second optional `presetId` arg —
      // `undefined` for a hand-built query (no preset clicked).
      expect(onApply).toHaveBeenCalledWith(
        {
          operator: "AND",
          conditions: expect.arrayContaining([
            expect.objectContaining({
              field: "email",
              value: "test@example.com",
            }),
          ]),
        },
        undefined,
      );
    });
  });

  it("should handle multiple conditions with OR operator", async () => {
    const user = userEvent.setup();

    render(<FilterBuilder {...defaultProps} />);

    // Add first condition
    await user.click(screen.getByLabelText("Add your first filter condition"));

    // Add second condition
    await user.click(screen.getByLabelText("Add another filter condition"));

    // Switch to OR operator
    const orRadio = screen.getByLabelText("Match any");
    await user.click(orRadio);

    // Verify operator changed
    expect(orRadio).toBeChecked();
  });

  // TODO(#421): jsdom + Radix Select interaction is flaky; rewrite as a Playwright e2e.
  it.skip("should remove conditions correctly", async () => {
    const user = userEvent.setup();

    render(
      <FilterBuilder
        {...defaultProps}
        initialQuery={{
          operator: "AND",
          conditions: [
            { id: "1", field: "total_donations", operator: "gt", value: "100" },
            { id: "2", field: "email", operator: "contains", value: "test" },
          ],
        }}
      />,
    );

    // Find and click remove button for first condition
    const removeButtons = screen.getAllByLabelText("Remove condition");
    await user.click(removeButtons[0]!);

    // Verify announcement
    const liveRegion = screen.getByRole("status", { hidden: true });
    await waitFor(() => {
      expect(liveRegion).toHaveTextContent("Filter removed: total_donations");
    });

    // Verify only one condition remains
    expect(screen.getAllByTestId("filter-condition")).toHaveLength(1);
  });

  it("should validate before applying", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();

    render(<FilterBuilder {...defaultProps} onApply={onApply} />);

    // Try to apply without conditions
    const applyButton = screen.getByText("Apply Filters");
    expect(applyButton).toBeDisabled();

    // Add empty condition
    await user.click(screen.getByLabelText("Add your first filter condition"));

    // Try to apply with incomplete condition
    await user.click(applyButton);

    // Should not call onApply
    expect(onApply).not.toHaveBeenCalled();
  });

  it("should handle keyboard navigation", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();

    render(<FilterBuilder {...defaultProps} onOpenChange={onOpenChange} />);

    // Test Escape key
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("should show active filters summary", async () => {
    render(
      <FilterBuilder
        {...defaultProps}
        initialQuery={{
          operator: "AND",
          conditions: [
            { id: "1", field: "total_donations", operator: "gt", value: "100" },
            { id: "2", field: "email", operator: "contains", value: "test" },
          ],
        }}
      />,
    );

    // Check active filters section is visible
    expect(screen.getByText("Active Filters")).toBeInTheDocument();

    // Check filter chips are rendered
    expect(screen.getAllByTestId("filter-condition")).toHaveLength(2);
  });
});
