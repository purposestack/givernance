import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { FilterBuilder } from "./FilterBuilder";
import type { Filter, FilterCondition } from "./filter-types";

// Mock next-intl
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: any) => {
    const translations: Record<string, string> = {
      "title": "Filter Constituents",
      "addFilter": "Add Filter",
      "addCondition": "Add Condition",
      "clearAll": "Clear All",
      "matchCount": `${values?.count || 0} matches`,
      "counting": "Calculating matches...",
      "empty": "No filters applied",
      "getStarted": "Use preset templates or create custom filters",
    };
    return translations[key] || key;
  },
}));

describe("FilterBuilder", () => {
  const mockOnChange = vi.fn();

  beforeEach(() => {
    mockOnChange.mockClear();
  });

  it("renders empty state when no filter is provided", () => {
    render(<FilterBuilder filter={null} onChange={mockOnChange} />);
    
    expect(screen.getByText("Filter Constituents")).toBeInTheDocument();
    expect(screen.getByText("No filters applied")).toBeInTheDocument();
    expect(screen.getByText("Use preset templates or create custom filters")).toBeInTheDocument();
  });

  it("renders filter conditions when filter is provided", () => {
    const filter: Filter = {
      id: "test-filter",
      conditions: [
        {
          id: "condition-1",
          field: "email",
          operator: "contains",
          value: "@example.com",
        },
      ],
      logic: "AND",
    };

    render(<FilterBuilder filter={filter} onChange={mockOnChange} />);
    
    expect(screen.getByText(/Email contains @example.com/i)).toBeInTheDocument();
  });

  it("shows match count when provided", () => {
    const filter: Filter = {
      id: "test-filter",
      conditions: [{
        id: "condition-1",
        field: "type",
        operator: "equals",
        value: "donor",
      }],
      logic: "AND",
    };

    render(
      <FilterBuilder 
        filter={filter} 
        onChange={mockOnChange}
        showCount={true}
        matchCount={42}
      />
    );
    
    expect(screen.getByText("42 matches")).toBeInTheDocument();
  });

  it("shows loading state when counting", () => {
    const filter: Filter = {
      id: "test-filter",
      conditions: [{
        id: "condition-1",
        field: "type",
        operator: "equals",
        value: "donor",
      }],
      logic: "AND",
    };

    render(
      <FilterBuilder 
        filter={filter} 
        onChange={mockOnChange}
        showCount={true}
        countLoading={true}
      />
    );
    
    expect(screen.getByText("Calculating matches...")).toBeInTheDocument();
  });

  it("removes condition when clicking remove button", async () => {
    const user = userEvent.setup();
    const filter: Filter = {
      id: "test-filter",
      conditions: [
        {
          id: "condition-1",
          field: "email",
          operator: "contains",
          value: "@example.com",
        },
        {
          id: "condition-2",
          field: "type",
          operator: "equals",
          value: "donor",
        },
      ],
      logic: "AND",
    };

    render(<FilterBuilder filter={filter} onChange={mockOnChange} />);
    
    const removeButtons = screen.getAllByLabelText("Remove filter");
    await user.click(removeButtons[0]);
    
    expect(mockOnChange).toHaveBeenCalledWith({
      ...filter,
      conditions: [filter.conditions[1]],
    });
  });

  it("clears all filters when clicking clear all", async () => {
    const user = userEvent.setup();
    const filter: Filter = {
      id: "test-filter",
      conditions: [{
        id: "condition-1",
        field: "type",
        operator: "equals",
        value: "donor",
      }],
      logic: "AND",
    };

    render(<FilterBuilder filter={filter} onChange={mockOnChange} />);
    
    const clearButton = screen.getByText("Clear All");
    await user.click(clearButton);
    
    expect(mockOnChange).toHaveBeenCalledWith(null);
  });

  it("toggles logic between AND/OR", async () => {
    const user = userEvent.setup();
    const filter: Filter = {
      id: "test-filter",
      conditions: [
        {
          id: "condition-1",
          field: "email",
          operator: "contains",
          value: "@example.com",
        },
        {
          id: "condition-2",
          field: "type",
          operator: "equals",
          value: "donor",
        },
      ],
      logic: "AND",
    };

    render(<FilterBuilder filter={filter} onChange={mockOnChange} />);
    
    const logicButton = screen.getByText("AND");
    await user.click(logicButton);
    
    expect(mockOnChange).toHaveBeenCalledWith({
      ...filter,
      logic: "OR",
    });
  });

  it("renders in compact mode", () => {
    const filter: Filter = {
      id: "test-filter",
      conditions: [
        {
          id: "condition-1",
          field: "email",
          operator: "contains",
          value: "@example.com",
        },
      ],
      logic: "AND",
    };

    render(
      <FilterBuilder 
        filter={filter} 
        onChange={mockOnChange}
        compact={true}
      />
    );
    
    // In compact mode, should show condensed UI
    expect(screen.getByText(/Email contains @example.com/i)).toBeInTheDocument();
    expect(screen.queryByText("Filter Constituents")).not.toBeInTheDocument();
  });
});