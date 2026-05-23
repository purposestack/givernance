// @ts-nocheck
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { FilterBuilder } from "../FilterBuilder";
import type { FilterQuery } from "../filter-types";

// Mock API calls
const mockFetchConstituents = vi.fn();

vi.mock("@/lib/api", () => ({
  fetchConstituents: () => mockFetchConstituents(),
}));

// Mock next-intl
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, _values?: Record<string, unknown>) => key,
}));

// TODO(#421): jsdom can't faithfully simulate Radix Select / Popover dropdowns —
// the rendered option list never appears in the test DOM, so every `getByText`
// for a dropdown option throws. Rewrite as a Playwright e2e against the real
// browser before re-enabling.
describe.skip("Filter Integration Tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchConstituents.mockResolvedValue({
      constituents: [],
      total: 0,
    });
  });

  describe("Date Filter Edge Cases", () => {
    it("handles leap year date ranges correctly", async () => {
      const user = userEvent.setup();
      const onApply = vi.fn();

      render(<FilterBuilder open={true} onOpenChange={vi.fn()} onApply={onApply} />);

      // Add date filter
      await user.click(screen.getByText("addCondition"));

      // Select date field and between operator
      const fieldSelects = screen.getAllByRole("combobox");
      await user.click(fieldSelects[1]!);
      await user.click(screen.getByText("fields.donationsLastDate"));

      await user.click(fieldSelects[2]!);
      await user.click(screen.getByText("operators.between"));

      // Set leap year date range
      const dateInputs = screen.getAllByPlaceholderText(/date/i);
      await user.type(dateInputs[0], "2024-02-28");
      await user.type(dateInputs[1], "2024-03-01");

      await user.click(screen.getByText("apply"));

      expect(onApply).toHaveBeenCalledWith({
        operator: "AND",
        conditions: [
          expect.objectContaining({
            field: "donations.lastDate",
            operator: "between",
            value: ["2024-02-28", "2024-03-01"],
          }),
        ],
      });
    });

    it("validates end date is after start date", async () => {
      const user = userEvent.setup();
      const onApply = vi.fn();

      render(<FilterBuilder open={true} onOpenChange={vi.fn()} onApply={onApply} />);

      await user.click(screen.getByText("addCondition"));

      const fieldSelects = screen.getAllByRole("combobox");
      await user.click(fieldSelects[1]!);
      await user.click(screen.getByText("fields.donationsLastDate"));

      await user.click(fieldSelects[2]!);
      await user.click(screen.getByText("operators.between"));

      const dateInputs = screen.getAllByPlaceholderText(/date/i);
      await user.type(dateInputs[0], "2025-12-31");
      await user.type(dateInputs[1], "2025-01-01");

      await user.click(screen.getByText("apply"));

      // Should show validation error
      expect(screen.getByText("validation.dateRangeInvalid")).toBeInTheDocument();
      expect(onApply).not.toHaveBeenCalled();
    });

    it("handles timezone conversions for date filters", async () => {
      const user = userEvent.setup();
      const onApply = vi.fn();

      render(<FilterBuilder open={true} onOpenChange={vi.fn()} onApply={onApply} />);

      await user.click(screen.getByText("addCondition"));

      const fieldSelects = screen.getAllByRole("combobox");
      await user.click(fieldSelects[1]!);
      await user.click(screen.getByText("fields.donationsLastDate"));

      // Set a date that crosses timezone boundaries
      const dateInput = screen.getByPlaceholderText(/value/i);
      await user.type(dateInput, "2025-12-31");

      await user.click(screen.getByText("apply"));

      expect(onApply).toHaveBeenCalledWith({
        operator: "AND",
        conditions: [
          expect.objectContaining({
            field: "donations.lastDate",
            operator: "eq",
            value: "2025-12-31",
          }),
        ],
      });
    });
  });

  describe("Complex Filter Combinations", () => {
    it("handles nested AND/OR logic correctly", async () => {
      const user = userEvent.setup();
      const onApply = vi.fn();

      render(<FilterBuilder open={true} onOpenChange={vi.fn()} onApply={onApply} />);

      // Add multiple conditions
      for (let i = 0; i < 3; i++) {
        await user.click(screen.getByText("addCondition"));
      }

      // Switch to OR operator
      await user.click(screen.getByLabelText("operator.OR"));

      // Configure conditions
      const conditions = screen.getAllByTestId(/filter-condition-/);

      // First condition: amount > 1000
      const firstCondition = conditions[0];
      const firstSelects = firstCondition.querySelectorAll('[role="combobox"]');
      await user.click(firstSelects[0]!);
      await user.click(screen.getByText("fields.donationsLastAmount"));
      await user.click(firstSelects[1]!);
      await user.click(screen.getByText("operators.gt"));
      await user.type(firstCondition.querySelector('input[type="number"]')!, "1000");

      // Apply filters
      await user.click(screen.getByText("apply"));

      expect(onApply).toHaveBeenCalledWith(
        expect.objectContaining({
          operator: "OR",
          conditions: expect.arrayContaining([
            expect.objectContaining({
              field: "donations.lastAmount",
              operator: "gt",
              value: "1000",
            }),
          ]),
        }),
      );
    });

    it("validates maximum query complexity", async () => {
      const user = userEvent.setup();
      const onApply = vi.fn();

      render(<FilterBuilder open={true} onOpenChange={vi.fn()} onApply={onApply} />);

      // Add maximum allowed conditions (e.g., 10)
      for (let i = 0; i < 10; i++) {
        await user.click(screen.getByText("addCondition"));
      }

      // Try to add one more
      const addButton = screen.getByText("addCondition");
      await user.click(addButton);

      // Should show max conditions error or disable button
      const conditions = screen.getAllByTestId(/filter-condition-/);
      expect(conditions.length).toBeLessThanOrEqual(10);
    });

    it("handles empty condition groups gracefully", async () => {
      const user = userEvent.setup();
      const onApply = vi.fn();

      render(<FilterBuilder open={true} onOpenChange={vi.fn()} onApply={onApply} />);

      // Don't add any conditions, just try to apply
      await user.click(screen.getByText("apply"));

      // Should apply with empty conditions array
      expect(onApply).toHaveBeenCalledWith({
        operator: "AND",
        conditions: [],
      });
    });
  });

  describe("Error Recovery", () => {
    it("recovers from network errors during preview", async () => {
      const user = userEvent.setup();
      mockFetchConstituents.mockRejectedValueOnce(new Error("Network error"));

      render(<FilterBuilder open={true} onOpenChange={vi.fn()} onApply={vi.fn()} />);

      // Add a condition
      await user.click(screen.getByText("addCondition"));

      // Wait for preview error
      await waitFor(() => {
        expect(screen.getByText(/error/i)).toBeInTheDocument();
      });

      // Should still allow applying filters
      const applyButton = screen.getByText("apply");
      expect(applyButton).toBeEnabled();
    });

    it("handles invalid filter data gracefully", async () => {
      const user = userEvent.setup();
      const invalidQuery: FilterQuery = {
        operator: "AND",
        conditions: [
          {
            id: "1",
            field: "invalid.field",
            operator: "invalid_op" as import("../filter-types").FilterOperator,
            value: undefined as unknown,
          },
        ],
      };

      render(
        <FilterBuilder
          open={true}
          onOpenChange={vi.fn()}
          onApply={vi.fn()}
          initialQuery={invalidQuery}
        />,
      );

      // Should render without crashing
      expect(screen.getByText("title")).toBeInTheDocument();

      // Should show validation error when trying to apply
      await user.click(screen.getByText("apply"));
      expect(screen.getByText(/error/i)).toBeInTheDocument();
    });

    it("preserves valid conditions when one fails validation", async () => {
      const user = userEvent.setup();
      const onApply = vi.fn();

      render(<FilterBuilder open={true} onOpenChange={vi.fn()} onApply={onApply} />);

      // Add two conditions
      await user.click(screen.getByText("addCondition"));
      await user.click(screen.getByText("addCondition"));

      // Configure first condition (valid)
      const conditions = screen.getAllByTestId(/filter-condition-/);
      const firstCondition = conditions[0];
      const firstSelects = firstCondition.querySelectorAll('[role="combobox"]');
      await user.click(firstSelects[0]!);
      await user.click(screen.getAllByText("fields.email")[0]);
      await user.type(firstCondition.querySelector('input[type="text"]')!, "test@example.com");

      // Leave second condition invalid (empty)

      // Try to apply
      await user.click(screen.getByText("apply"));

      // Should show error for incomplete conditions
      expect(screen.getByText("error.incompleteConditions")).toBeInTheDocument();
      expect(onApply).not.toHaveBeenCalled();
    });
  });

  describe("Special Value Handling", () => {
    it("handles null and empty values correctly", async () => {
      const user = userEvent.setup();
      const onApply = vi.fn();

      render(<FilterBuilder open={true} onOpenChange={vi.fn()} onApply={onApply} />);

      await user.click(screen.getByText("addCondition"));

      const fieldSelects = screen.getAllByRole("combobox");
      await user.click(fieldSelects[1]!);
      await user.click(screen.getByText("fields.email"));

      // Select exists operator (no value needed)
      await user.click(fieldSelects[2]!);
      await user.click(screen.getByText("operators.exists"));

      await user.click(screen.getByText("apply"));

      expect(onApply).toHaveBeenCalledWith({
        operator: "AND",
        conditions: [
          expect.objectContaining({
            field: "email",
            operator: "exists",
            value: null,
          }),
        ],
      });
    });

    it("handles array values for multi-select fields", async () => {
      const user = userEvent.setup();
      const onApply = vi.fn();

      render(<FilterBuilder open={true} onOpenChange={vi.fn()} onApply={onApply} />);

      await user.click(screen.getByText("addCondition"));

      const fieldSelects = screen.getAllByRole("combobox");
      await user.click(fieldSelects[1]!);
      await user.click(screen.getByText("fields.tagsAny"));

      // Mock selecting multiple tags
      // In real implementation this would be a multi-select component
      const tagInput = screen.getByPlaceholderText(/value/i);
      await user.type(tagInput, "vip,newsletter");

      await user.click(screen.getByText("apply"));

      expect(onApply).toHaveBeenCalledWith({
        operator: "AND",
        conditions: [
          expect.objectContaining({
            field: "tags",
            operator: "contains",
            value: expect.stringContaining("vip"),
          }),
        ],
      });
    });

    it("handles very large numbers correctly", async () => {
      const user = userEvent.setup();
      const onApply = vi.fn();

      render(<FilterBuilder open={true} onOpenChange={vi.fn()} onApply={onApply} />);

      await user.click(screen.getByText("addCondition"));

      const fieldSelects = screen.getAllByRole("combobox");
      await user.click(fieldSelects[1]!);
      await user.click(screen.getByText("fields.donationsTotalAmount"));

      const numberInput = screen.getByPlaceholderText(/value/i);
      await user.type(numberInput, "9999999999.99");

      await user.click(screen.getByText("apply"));

      expect(onApply).toHaveBeenCalledWith({
        operator: "AND",
        conditions: [
          expect.objectContaining({
            field: "donations.totalAmount",
            operator: "eq",
            value: "9999999999.99",
          }),
        ],
      });
    });
  });
});
