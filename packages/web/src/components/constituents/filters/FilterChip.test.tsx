import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { FilterChip, FilterChipGroup } from "./FilterChip";
import type { FilterCondition } from "./filter-types";

describe("FilterChip", () => {
  const mockCondition: FilterCondition = {
    id: "test-1",
    field: "email",
    operator: "contains",
    value: "@example.com",
  };

  it("renders condition label", () => {
    render(<FilterChip condition={mockCondition} />);
    expect(screen.getByText(/Email contains @example.com/i)).toBeInTheDocument();
  });

  it("renders custom label when provided", () => {
    const conditionWithLabel = {
      ...mockCondition,
      label: "Custom Label",
    };
    render(<FilterChip condition={conditionWithLabel} />);
    expect(screen.getByText("Custom Label")).toBeInTheDocument();
  });

  it("calls onRemove when remove button clicked", async () => {
    const user = userEvent.setup();
    const mockOnRemove = vi.fn();
    
    render(<FilterChip condition={mockCondition} onRemove={mockOnRemove} />);
    
    const removeButton = screen.getByLabelText("Remove filter");
    await user.click(removeButton);
    
    expect(mockOnRemove).toHaveBeenCalledWith(mockCondition.id);
  });

  it("hides remove button when onRemove not provided", () => {
    render(<FilterChip condition={mockCondition} />);
    expect(screen.queryByLabelText("Remove filter")).not.toBeInTheDocument();
  });

  it("renders in compact variant", () => {
    render(<FilterChip condition={mockCondition} variant="compact" />);
    // Compact variant should still show the label
    expect(screen.getByText(/Email contains @example.com/i)).toBeInTheDocument();
  });
});

describe("FilterChipGroup", () => {
  const mockConditions: FilterCondition[] = [
    {
      id: "test-1",
      field: "email",
      operator: "contains",
      value: "@example.com",
    },
    {
      id: "test-2",
      field: "type",
      operator: "equals",
      value: "donor",
    },
    {
      id: "test-3",
      field: "city",
      operator: "equals",
      value: "Geneva",
    },
  ];

  it("renders all conditions with AND logic", () => {
    render(<FilterChipGroup conditions={mockConditions} logic="AND" />);
    
    expect(screen.getByText(/Email contains @example.com/i)).toBeInTheDocument();
    expect(screen.getByText(/Type is donor/i)).toBeInTheDocument();
    expect(screen.getByText(/City is Geneva/i)).toBeInTheDocument();
    
    // Should show AND between conditions
    const andOperators = screen.getAllByText("AND");
    expect(andOperators).toHaveLength(2); // N-1 operators for N conditions
  });

  it("renders with OR logic", () => {
    render(<FilterChipGroup conditions={mockConditions} logic="OR" />);
    
    const orOperators = screen.getAllByText("OR");
    expect(orOperators).toHaveLength(2);
  });

  it("limits visible conditions when maxVisible set", () => {
    render(<FilterChipGroup conditions={mockConditions} maxVisible={2} />);
    
    expect(screen.getByText(/Email contains @example.com/i)).toBeInTheDocument();
    expect(screen.getByText(/Type is donor/i)).toBeInTheDocument();
    expect(screen.queryByText(/City is Geneva/i)).not.toBeInTheDocument();
    expect(screen.getByText("+1 more")).toBeInTheDocument();
  });

  it("calls onRemove for each chip", async () => {
    const user = userEvent.setup();
    const mockOnRemove = vi.fn();
    
    render(<FilterChipGroup conditions={mockConditions.slice(0, 2)} onRemove={mockOnRemove} />);
    
    const removeButtons = screen.getAllByLabelText("Remove filter");
    await user.click(removeButtons[0]);
    
    expect(mockOnRemove).toHaveBeenCalledWith("test-1");
  });
});