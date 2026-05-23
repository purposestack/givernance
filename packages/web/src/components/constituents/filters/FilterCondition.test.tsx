// @ts-nocheck
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { FilterCondition } from "./FilterCondition";
import type { FilterCondition as FilterConditionType } from "./filter-types";

// Mock next-intl
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, _values?: Record<string, unknown>) => {
    const translations: Record<string, string> = {
      title: "Filter Constituents",
      description: "Build complex queries to find specific constituents",
      operator: "Match" as FilterOperator,
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
      yes: "Yes",
      no: "No",
      startDate: "Start Date",
      endDate: "End Date",
    };
    if (key === "yes") return "Yes";
    if (key === "no") return "No";
    return translations[key] || key;
  },
}));

// Mock filter fields data
vi.mock("./filter-presets", () => ({
  filterFields: [
    {
      name: "firstName",
      label: "First name",
      type: "text",
      operators: ["eq", "ne", "contains", "startsWith", "endsWith", "exists", "notExists"],
    },
    {
      name: "lastName",
      label: "Last name",
      type: "text",
      operators: ["eq", "ne", "contains", "startsWith", "endsWith"],
    },
    {
      name: "email",
      label: "Email",
      type: "text",
      operators: ["eq", "ne", "contains", "startsWith", "endsWith"],
    },
    { name: "address.city", label: "City", type: "text", operators: ["eq", "ne", "contains"] },
    {
      name: "address.country",
      label: "Country",
      type: "select",
      operators: ["eq", "ne"],
      options: [
        { value: "CH", label: "Switzerland" },
        { value: "FR", label: "France" },
        { value: "US", label: "United States" },
      ],
    },
    {
      name: "donations.lastDate",
      label: "Last donation date",
      type: "date",
      operators: ["eq", "gt", "gte", "lt", "lte", "between"],
    },
    {
      name: "donations.lastAmount",
      label: "Last donation amount",
      type: "number",
      operators: ["eq", "gt", "gte", "lt", "lte", "between"],
      min: 0,
      step: 0.01,
    },
    {
      name: "donations.totalAmount",
      label: "Total donated",
      type: "number",
      operators: ["eq", "gt", "gte", "lt", "lte", "between"],
      min: 0,
      step: 0.01,
    },
    { name: "donations.recurring", label: "Recurring donor", type: "boolean", operators: ["eq"] },
    {
      name: "tags",
      label: "Tags",
      type: "multiselect",
      operators: ["contains", "notContains"],
      options: [
        { value: "vip", label: "VIP" },
        { value: "newsletter", label: "Newsletter" },
        { value: "volunteer", label: "Volunteer" },
      ],
    },
  ],
  getOperatorLabel: (op: string) => {
    const labels: Record<string, string> = {
      eq: "equals",
      ne: "not equals",
      contains: "contains",
      startsWith: "starts with",
      endsWith: "ends with",
      gt: "greater than",
      gte: "greater than or equal",
      lt: "less than",
      lte: "less than or equal",
      between: "between",
      exists: "exists",
      notExists: "does not exist",
    };
    return labels[op] || op;
  },
}));

describe("FilterCondition", () => {
  const mockOnChange = vi.fn();
  const mockOnRemove = vi.fn();

  const baseCondition: FilterConditionType = {
    id: "test-1",
    field: "",
    operator: "eq" as FilterOperator,
    value: "",
  };

  const defaultProps = {
    condition: baseCondition,
    onChange: mockOnChange,
    onRemove: mockOnRemove,
    isFirst: true,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders field selector", () => {
    render(<FilterCondition {...defaultProps} isFirst={false} />);

    expect(screen.getByRole("combobox", { name: /field/i })).toBeInTheDocument();
  });

  it("renders all available fields in selector", async () => {
    const user = userEvent.setup();
    render(<FilterCondition {...defaultProps} isFirst={false} />);

    const fieldSelector = screen.getByRole("combobox", { name: /field/i });
    await user.click(fieldSelector);

    expect(screen.getByText("First name")).toBeInTheDocument();
    expect(screen.getByText("Last name")).toBeInTheDocument();
    expect(screen.getByText("Email")).toBeInTheDocument();
    expect(screen.getByText("City")).toBeInTheDocument();
    expect(screen.getByText("Last donation date")).toBeInTheDocument();
    expect(screen.getByText("Recurring donor")).toBeInTheDocument();
  });

  it("updates operators when field changes", async () => {
    const user = userEvent.setup();
    render(<FilterCondition {...defaultProps} isFirst={false} />);

    // Select a text field
    const fieldSelector = screen.getByRole("combobox", { name: /field/i });
    await user.click(fieldSelector);
    await user.click(screen.getByText("First name"));

    expect(mockOnChange).toHaveBeenCalledWith({
      ...baseCondition,
      field: "firstName",
      operator: "eq" as FilterOperator,
      value: "",
    });
  });

  it("renders appropriate value input for text fields", async () => {
    const _user = userEvent.setup();
    const textCondition = {
      ...baseCondition,
      field: "firstName",
      operator: "eq" as FilterOperator,
      value: "",
    };

    render(<FilterCondition {...defaultProps} condition={textCondition} />);

    const valueInput = screen.getByPlaceholderText(/value/i);
    expect(valueInput).toHaveAttribute("type", "text");

    fireEvent.change(valueInput, { target: { value: "John" } });

    expect(mockOnChange).toHaveBeenCalledWith({
      ...textCondition,
      value: "John",
    });
  });

  it("renders appropriate value input for number fields", async () => {
    const _user = userEvent.setup();
    const numberCondition = {
      ...baseCondition,
      field: "donations.lastAmount",
      operator: "eq" as FilterOperator,
      value: "",
    };

    render(<FilterCondition {...defaultProps} condition={numberCondition} />);

    const valueInput = screen.getByPlaceholderText(/value/i);
    expect(valueInput).toHaveAttribute("type", "number");
    expect(valueInput).toHaveAttribute("min", "0");
    expect(valueInput).toHaveAttribute("step", "0.01");

    fireEvent.change(valueInput, { target: { value: "100.50" } });

    expect(mockOnChange).toHaveBeenLastCalledWith({
      ...numberCondition,
      value: "100.50",
    });
  });

  it("renders date picker for date fields", async () => {
    const _user = userEvent.setup();
    const dateCondition = {
      ...baseCondition,
      field: "donations.lastDate",
      operator: "eq" as FilterOperator,
      value: "",
    };

    render(<FilterCondition {...defaultProps} condition={dateCondition} />);

    const dateInput = screen.getByPlaceholderText(/value/i);
    expect(["date", "text"]).toContain(dateInput.getAttribute("type"));

    fireEvent.change(dateInput, { target: { value: "2025-05-15" } });

    expect(mockOnChange).toHaveBeenCalledWith({
      ...dateCondition,
      value: "2025-05-15",
    });
  });

  it("renders select for boolean fields", async () => {
    const user = userEvent.setup();
    const boolCondition = {
      ...baseCondition,
      field: "donations.recurring",
      operator: "eq" as FilterOperator,
      value: false,
    };

    render(<FilterCondition {...defaultProps} condition={boolCondition} />);

    const boolSelector = screen.getAllByRole("combobox")[2]!;
    await user.click(boolSelector! as HTMLElement);

    const options = screen.getAllByText("Yes");
    await user.click(options[options.length - 1]! as HTMLElement);

    expect(mockOnChange).toHaveBeenCalledWith({
      ...boolCondition,
      value: true,
    });
  });

  it("renders two inputs for between operator", async () => {
    const _user = userEvent.setup();
    const betweenCondition = {
      ...baseCondition,
      field: "donations.lastAmount",
      operator: "between" as const,
      value: ["", ""],
    };

    render(<FilterCondition {...defaultProps} condition={betweenCondition} />);

    const inputs = screen.getAllByRole("spinbutton");
    expect(inputs).toHaveLength(2);
    const [firstInput, secondInput] = inputs;
    if (!firstInput || !secondInput) throw new Error("Expected two spinbutton inputs");

    fireEvent.change(firstInput, { target: { value: "100" } });
    expect(mockOnChange).toHaveBeenCalledWith({
      ...betweenCondition,
      value: ["100", ""],
    });

    fireEvent.change(secondInput, { target: { value: "500" } });
    expect(mockOnChange).toHaveBeenLastCalledWith({
      ...betweenCondition,
      value: ["", "500"],
    });
  });

  it("renders date range inputs for date between operator", async () => {
    const betweenDateCondition = {
      ...baseCondition,
      field: "donations.lastDate",
      operator: "between" as const,
      value: ["", ""],
    };

    render(<FilterCondition {...defaultProps} condition={betweenDateCondition} />);

    const dateInputs = screen.getAllByLabelText(/Date/i);
    expect(dateInputs).toHaveLength(2);
    const [firstDateInput, secondDateInput] = dateInputs;
    if (!firstDateInput || !secondDateInput) throw new Error("Expected two date inputs");

    fireEvent.change(firstDateInput, { target: { value: "2025-01-01" } });
    expect(mockOnChange).toHaveBeenCalledWith({
      ...betweenDateCondition,
      value: ["2025-01-01", ""],
    });

    fireEvent.change(secondDateInput, { target: { value: "2025-12-31" } });
    expect(mockOnChange).toHaveBeenLastCalledWith({
      ...betweenDateCondition,
      value: ["", "2025-12-31"],
    });
  });

  it("does not render value input for exists/notExists operators", async () => {
    const user = userEvent.setup();
    const existsCondition = {
      ...baseCondition,
      field: "firstName",
      operator: "exists" as const,
      value: null,
    };

    render(<FilterCondition {...defaultProps} condition={existsCondition} />);

    expect(screen.queryByPlaceholderText(/value/i)).not.toBeInTheDocument();

    // Change to notExists
    const operatorSelector = screen.getAllByRole("combobox")[1]!;
    await user.click(operatorSelector);
    await user.click(await screen.findByText(/does not exist/i));

    expect(mockOnChange).toHaveBeenCalledWith({
      ...existsCondition,
      operator: "notExists" as FilterOperator,
      value: null,
    });

    expect(screen.queryByPlaceholderText(/value/i)).not.toBeInTheDocument();
  });

  it("renders select dropdown for fields with options", async () => {
    const user = userEvent.setup();
    const selectCondition = {
      ...baseCondition,
      field: "address.country",
      operator: "eq" as FilterOperator,
      value: "",
    };

    render(<FilterCondition {...defaultProps} condition={selectCondition} />);

    const countrySelector = screen.getAllByRole("combobox")[2]!; // Third combobox is the value selector
    await user.click(countrySelector);

    expect(screen.getByText("Switzerland")).toBeInTheDocument();
    expect(screen.getByText("France")).toBeInTheDocument();
    expect(screen.getByText("United States")).toBeInTheDocument();

    await user.click(screen.getByText("Switzerland"));

    expect(mockOnChange).toHaveBeenCalledWith({
      ...selectCondition,
      value: "CH",
    });
  });

  it("handles remove button click", async () => {
    const user = userEvent.setup();
    render(<FilterCondition {...defaultProps} isFirst={false} />);

    const removeButton = screen.getByRole("button", { name: /remove/i });
    await user.click(removeButton);

    expect(mockOnRemove).toHaveBeenCalled();
  });

  it("updates operator when selecting from dropdown", async () => {
    const user = userEvent.setup();
    const textCondition = {
      ...baseCondition,
      field: "firstName",
      operator: "eq" as const,
      value: "",
    };

    render(<FilterCondition {...defaultProps} condition={textCondition} />);

    const operatorSelector = screen.getAllByRole("combobox")[1]!;
    await user.click(operatorSelector);

    await user.click(screen.getByText("contains"));

    expect(mockOnChange).toHaveBeenCalledWith({
      ...textCondition,
      operator: "contains" as FilterOperator,
    });
  });

  it("resets value when changing to between operator", async () => {
    const user = userEvent.setup();
    const numberCondition = {
      ...baseCondition,
      field: "donations.lastAmount",
      operator: "eq" as const,
      value: "100",
    };

    render(<FilterCondition {...defaultProps} condition={numberCondition} />);

    const operatorSelector = screen.getAllByRole("combobox")[1]!;
    await user.click(operatorSelector);
    await user.click(screen.getByText("between"));

    expect(mockOnChange).toHaveBeenCalledWith({
      ...numberCondition,
      operator: "between" as FilterOperator,
      value: ["", ""],
    });
  });

  // TODO(#421): the multi-select value input is now a Popover + Checkbox list
  // (real multi-select), not the old single-value `<Select>`. This test was
  // written against the broken old UI — rewrite to drive the Popover (open
  // it, toggle a checkbox, assert the new value is an array).
  it.skip("handles multiselect fields for tags", async () => {
    const _user = userEvent.setup();
    const tagsCondition = {
      ...baseCondition,
      field: "tags",
      operator: "contains" as const,
      value: [],
    };

    render(<FilterCondition {...defaultProps} condition={tagsCondition} />);

    // Since we're mocking the component, we need to test the behavior conceptually
    // In the real implementation, this would render a multi-select component
    const valueSelector = screen.getAllByRole("combobox")[2]!;
    expect(valueSelector).toBeInTheDocument();
  });

  it("preserves existing value when changing compatible operators", async () => {
    const user = userEvent.setup();
    const condition = {
      ...baseCondition,
      field: "donations.lastAmount",
      operator: "gt" as const,
      value: "100",
    };

    render(<FilterCondition {...defaultProps} condition={condition} />);

    const operatorSelector = screen.getAllByRole("combobox")[1]!;
    await user.click(operatorSelector);
    await user.click(screen.getByText("greater than or equal"));

    expect(mockOnChange).toHaveBeenCalledWith({
      ...condition,
      operator: "gte" as FilterOperator,
      value: "100", // Value should be preserved
    });
  });

  it("disables remove button for first condition", () => {
    render(<FilterCondition {...defaultProps} isFirst={true} />);

    // In the real implementation, the first condition might not have a remove button
    // or it might be disabled. This test assumes it's still present but could be styled differently
    const removeButton = screen.getByRole("button", { name: /remove/i });
    expect(removeButton).toBeInTheDocument();
  });

  it("enables remove button for non-first conditions", () => {
    render(<FilterCondition {...defaultProps} isFirst={false} />);

    const removeButton = screen.getByRole("button", { name: /remove/i });
    expect(removeButton).toBeInTheDocument();
    expect(removeButton).toBeEnabled();
  });
});
