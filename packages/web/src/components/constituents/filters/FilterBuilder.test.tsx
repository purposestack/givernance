// @ts-nocheck
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { FilterBuilder } from "./FilterBuilder";
import type { FilterQuery } from "./filter-types";

// Mock dependencies that are not installed
vi.mock("@radix-ui/react-radio-group", () => ({
  Root: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <div data-testid="radio-group" {...props}>
      {children}
    </div>
  ),
  Item: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <input type="radio" {...props} />
  ),
}));

vi.mock("@radix-ui/react-dialog", () => ({
  Root: ({ children, open }: React.PropsWithChildren<{ open?: boolean }>) =>
    open ? children : null,
  Portal: ({ children }: React.PropsWithChildren) => children,
  Overlay: ({ children }: React.PropsWithChildren) => (
    <div data-testid="dialog-overlay">{children}</div>
  ),
  Content: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <div data-testid="dialog-content" {...props}>
      {children}
    </div>
  ),
  Header: ({ children }: React.PropsWithChildren) => (
    <div data-testid="dialog-header">{children}</div>
  ),
  Footer: ({ children }: React.PropsWithChildren) => (
    <div data-testid="dialog-footer">{children}</div>
  ),
  Title: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
  Description: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
  Close: ({ children }: React.PropsWithChildren) => (
    <button type="button" data-testid="dialog-close">
      {children}
    </button>
  ),
}));

// Mock next-intl
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    const translations: Record<string, string> = {
      title: "Filter Constituents",
      description: "Build complex queries to find specific constituents",
      operator: "Match",
      "operator.AND": "all conditions",
      "operator.OR": "any condition",
      addCondition: "Add condition",
      "preview.label": "Preview",
      "preview.loading": "Loading...",
      "preview.result": "{count} constituents match",
      apply: "Apply Filters",
      cancel: "Cancel",
      "validation.incomplete": "Please complete all conditions",
      presetApplied: "Applied preset: {name}",
      "validation.fieldRequired": "Field is required",
      "validation.valueRequired": "Value is required",
      "validation.dateRangeInvalid": "End date must be after start date",
    };

    if (values) {
      return translations[key]?.replace(/{(\w+)}/g, (_, k) => values[k] || `{${k}}`);
    }
    return translations[key] || key;
  },
}));

// Mock toast
vi.mock("@/components/ui/toast", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

// Mock child components
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
    <div data-testid={`filter-condition-${condition.id}`}>
      <input
        data-testid="field-select"
        value={condition.field}
        onChange={(e) => onChange({ ...condition, field: e.target.value })}
      />
      <input
        data-testid="operator-select"
        value={condition.operator}
        onChange={(e) => onChange({ ...condition, operator: e.target.value })}
      />
      <input
        data-testid="value-input"
        value={condition.value}
        onChange={(e) => onChange({ ...condition, value: e.target.value })}
      />
      <button type="button" onClick={onRemove}>
        Remove
      </button>
    </div>
  ),
}));

vi.mock("./FilterPreview", () => ({
  FilterPreview: ({
    query,
    onCountChange,
  }: {
    query: import("./filter-types").FilterQuery;
    onCountChange: (count: number) => void;
  }) => {
    // Simulate preview count calculation
    React.useEffect(() => {
      if (onCountChange && typeof onCountChange === "function") {
        if (query.conditions.length > 0) {
          onCountChange(100); // Mock count
        } else {
          onCountChange(0);
        }
      }
    }, [query, onCountChange]);

    return <div data-testid="filter-preview">Preview: {query.conditions.length} conditions</div>;
  },
}));

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
          onSelect({
            id: "recent-donors",
            name: "Recent Donors",
            query: {
              operator: "AND",
              conditions: [
                { id: "1", field: "donations.lastDate", operator: "gte", value: "2025-01-01" },
              ],
            },
          })
        }
      >
        Recent Donors
      </button>
    </div>
  ),
}));

// Mock hooks
vi.mock("@/hooks/use-focus-return", () => ({
  useFocusReturn: vi.fn(),
}));

// Mock UI components
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/label", () => ({
  Label: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <label htmlFor="mock-input" {...props}>
      {children}
    </label>
  ),
}));

vi.mock("@/components/ui/radio-group", () => ({
  RadioGroup: ({
    children,
    onValueChange,
    value,
    ...props
  }: React.PropsWithChildren<{ onValueChange?: (value: string) => void; value?: string }>) => (
    <div data-testid="radio-group" {...props}>
      {React.Children.map(children, (child) =>
        React.cloneElement(child, { onValueChange, currentValue: value }),
      )}
    </div>
  ),
  RadioGroupItem: ({
    value,
    onValueChange,
    currentValue,
    ...props
  }: React.PropsWithChildren<{
    value?: string;
    onValueChange?: (value: string) => void;
    currentValue?: string;
  }>) => (
    <input
      type="radio"
      value={value}
      checked={currentValue === value}
      onChange={(e) => onValueChange?.(e.target.value)}
      {...props}
    />
  ),
}));

vi.mock("@/components/ui/separator", () => ({
  Separator: () => <hr />,
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({
    children,
    open,
  }: React.PropsWithChildren<{ open?: boolean; onOpenChange?: (open: boolean) => void }>) => {
    return open ? <div data-testid="dialog-root">{children}</div> : null;
  },
  DialogContent: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <div data-testid="dialog-content" {...props}>
      {children}
    </div>
  ),
  DialogHeader: ({ children }: React.PropsWithChildren) => (
    <div data-testid="dialog-header">{children}</div>
  ),
  DialogFooter: ({ children }: React.PropsWithChildren) => (
    <div data-testid="dialog-footer">{children}</div>
  ),
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
}));

// Add React import for the mock
import React from "react";

describe("FilterBuilder", () => {
  const mockOnApply = vi.fn();
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    onApply: mockOnApply,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the filter builder dialog", () => {
    render(<FilterBuilder {...defaultProps} />);

    expect(screen.getByText("Filter Constituents")).toBeInTheDocument();
    expect(
      screen.getByText("Build complex queries to find specific constituents"),
    ).toBeInTheDocument();
  });

  it("allows adding new filter conditions", async () => {
    const user = userEvent.setup();
    render(<FilterBuilder {...defaultProps} />);

    const addButton = screen.getByText("Add condition");
    await user.click(addButton);

    await waitFor(() => {
      expect(screen.getByTestId(/filter-condition-/)).toBeInTheDocument();
    });
  });

  it("allows removing filter conditions", async () => {
    const user = userEvent.setup();
    render(<FilterBuilder {...defaultProps} />);

    // Add a condition first
    await user.click(screen.getByText("Add condition"));

    const condition = await screen.findByTestId(/filter-condition-/);
    const removeButton = within(condition).getByText("Remove");

    await user.click(removeButton);

    expect(screen.queryByTestId(/filter-condition-/)).not.toBeInTheDocument();
  });

  it("validates conditions before applying", async () => {
    const user = userEvent.setup();
    const { toast } = await import("@/components/ui/toast");

    render(<FilterBuilder {...defaultProps} />);

    // Add an empty condition
    await user.click(screen.getByText("Add condition"));

    // Try to apply without completing the condition
    await user.click(screen.getByText("Apply Filters"));

    expect(toast.error).toHaveBeenCalledWith("Please complete all conditions");
    expect(mockOnApply).not.toHaveBeenCalled();
  });

  it("applies valid filter query", async () => {
    const user = userEvent.setup();
    mockOnApply.mockResolvedValue(undefined);

    render(<FilterBuilder {...defaultProps} />);

    // Add a condition
    await user.click(screen.getByText("Add condition"));

    const condition = await screen.findByTestId(/filter-condition-/);

    // Fill in the condition
    const fieldInput = within(condition).getByTestId("field-select");
    const operatorInput = within(condition).getByTestId("operator-select");
    const valueInput = within(condition).getByTestId("value-input");

    await user.type(fieldInput, "address.city");
    await user.clear(operatorInput);
    await user.type(operatorInput, "eq");
    await user.type(valueInput, "Geneva");

    // Apply filters
    await user.click(screen.getByText("Apply Filters"));

    await waitFor(() => {
      // FilterBuilder.onApply now takes a second optional `presetId` arg so
      // the parent strip can render a "Filter preset: …" affordance. When the
      // user hand-builds a query (no preset clicked) the id is `undefined`.
      expect(mockOnApply).toHaveBeenCalledWith(
        {
          operator: "AND",
          conditions: [
            expect.objectContaining({
              field: "address.city",
              operator: "eq",
              value: "Geneva",
            }),
          ],
        },
        undefined,
      );
    });
  });

  it("loads initial query correctly", () => {
    const initialQuery: FilterQuery = {
      operator: "OR",
      conditions: [
        { id: "1", field: "donations.totalAmount", operator: "gte", value: 1000 },
        { id: "2", field: "address.countryCode", operator: "eq", value: "CH" },
      ],
    };

    render(<FilterBuilder {...defaultProps} initialQuery={initialQuery} />);

    // Check that conditions are loaded
    expect(screen.getByTestId("filter-condition-1")).toBeInTheDocument();
    expect(screen.getByTestId("filter-condition-2")).toBeInTheDocument();
  });

  it("handles preset selection", async () => {
    const user = userEvent.setup();
    const { toast } = await import("@/components/ui/toast");

    render(<FilterBuilder {...defaultProps} />);

    // Click on a preset
    const presetButton = within(screen.getByTestId("filter-presets")).getByText("Recent Donors");
    await user.click(presetButton);

    // Check toast notification
    expect(toast.success).toHaveBeenCalledWith("Applied preset: Recent Donors");

    // Check that condition was added
    await waitFor(() => {
      expect(screen.getByTestId(/filter-condition-/)).toBeInTheDocument();
    });
  });

  it("updates preview count when conditions change", async () => {
    const user = userEvent.setup();
    render(<FilterBuilder {...defaultProps} />);

    // Initially no conditions
    expect(screen.getByTestId("filter-preview")).toHaveTextContent("Preview: 0 conditions");

    // Add a condition
    await user.click(screen.getByText("Add condition"));

    await waitFor(() => {
      expect(screen.getByTestId("filter-preview")).toHaveTextContent("Preview: 1 conditions");
    });
  });
});
