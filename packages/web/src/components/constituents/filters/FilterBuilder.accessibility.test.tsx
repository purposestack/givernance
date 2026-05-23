// @ts-nocheck
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { FilterBuilder } from "./FilterBuilder";

// Mock next-intl
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    const translations: Record<string, string> = {
      title: "Advanced Filters",
      description: "Build complex queries",
      cancel: "Cancel",
      apply: "Apply Filters",
      filterRemoved: `Filter removed: ${values?.field || ""}`,
      previewAnnouncement: `${values?.count || 0} constituents match your filters`,
      addFirstCondition: "Add your first filter condition",
      selectField: "Select field",
      selectOperator: "Select operator",
      enterValueFor: `Enter value for ${values?.field || "field"}`,
    };
    return translations[key] || key;
  },
}));

// TODO(#421): jsdom can't faithfully simulate Radix focus-trap / keyboard
// behaviour; rewrite as a Playwright e2e against the real browser.
describe.skip("FilterBuilder Accessibility", () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    onApply: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should have proper ARIA attributes", () => {
    const { container } = render(<FilterBuilder {...defaultProps} />);

    // Check for essential ARIA attributes
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-label");

    // Check for live region
    const liveRegion = container.querySelector('[aria-live="polite"]');
    expect(liveRegion).toBeInTheDocument();
    expect(liveRegion).toHaveAttribute("aria-atomic", "true");
  });

  it("should have proper ARIA labels", () => {
    render(<FilterBuilder {...defaultProps} />);

    expect(screen.getByRole("dialog")).toHaveAttribute("aria-label", "Advanced Filters");
    expect(screen.getByLabelText("Add your first filter condition")).toBeInTheDocument();
  });

  it("should announce preview count changes to screen readers", async () => {
    render(<FilterBuilder {...defaultProps} />);

    // Check that live region exists
    const liveRegion = screen.getByRole("status", { hidden: true });
    expect(liveRegion).toHaveAttribute("aria-live", "polite");
    expect(liveRegion).toHaveAttribute("aria-atomic", "true");
  });

  it("should close dialog on Escape key", async () => {
    const onOpenChange = vi.fn();
    render(<FilterBuilder {...defaultProps} onOpenChange={onOpenChange} />);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("should return focus to trigger element on close", async () => {
    // Create a trigger button
    const triggerButton = document.createElement("button");
    triggerButton.textContent = "Open Filters";
    document.body.appendChild(triggerButton);

    // Focus the trigger
    triggerButton.focus();
    expect(document.activeElement).toBe(triggerButton);

    // Render with open=true
    render(<FilterBuilder {...defaultProps} open={true} />);

    // Close the dialog
    rerender(<FilterBuilder {...defaultProps} open={false} />);

    // Wait for focus return
    await waitFor(() => {
      expect(document.activeElement).toBe(triggerButton);
    });

    // Cleanup
    document.body.removeChild(triggerButton);
  });

  it("should have keyboard navigable controls", async () => {
    const user = userEvent.setup();
    render(<FilterBuilder {...defaultProps} />);

    const addButton = screen.getByLabelText("Add your first filter condition");

    // Tab to the button
    await user.tab();
    await user.tab();

    // Check button can be activated with Enter/Space
    expect(addButton).toHaveFocus();
    await user.keyboard("{Enter}");

    // Should now show field selector
    expect(screen.getByLabelText("Select field")).toBeInTheDocument();
  });

  it("should announce filter removals", async () => {
    render(
      <FilterBuilder
        {...defaultProps}
        initialQuery={{
          operator: "AND",
          conditions: [
            { id: "1", field: "total_donations", operator: "gt", value: "100" },
            { id: "2", field: "last_donation_date", operator: "after", value: "2024-01-01" },
          ],
        }}
      />,
    );

    const liveRegion = screen.getByRole("status", { hidden: true });
    const removeButtons = screen.getAllByLabelText(/Remove condition/);

    // Click remove button
    fireEvent.click(removeButtons[0]);

    // Check announcement
    await waitFor(() => {
      expect(liveRegion).toHaveTextContent("Filter removed: total_donations");
    });
  });

  it("should support high contrast mode", () => {
    // Mock matchMedia for high contrast
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: query === "(prefers-contrast: high)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    render(<FilterBuilder {...defaultProps} />);

    // Component should render without issues in high contrast mode
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("should have visible focus indicators", async () => {
    const user = userEvent.setup();
    render(<FilterBuilder {...defaultProps} />);

    // Tab through interactive elements
    await user.tab();

    // Check that focused element has visible focus style
    const focusedElement = document.activeElement;
    expect(focusedElement).toHaveClass("focus-visible:ring-2");
  });

  it("should properly label form controls", async () => {
    render(
      <FilterBuilder
        {...defaultProps}
        initialQuery={{
          operator: "AND",
          conditions: [{ id: "1", field: "email", operator: "contains", value: "" }],
        }}
      />,
    );

    // Check that value input has proper label
    const valueInput = screen.getByLabelText("Enter value for email");
    expect(valueInput).toBeInTheDocument();
  });

  it("should maintain proper tab order in modal", async () => {
    const user = userEvent.setup();
    render(<FilterBuilder {...defaultProps} />);

    const interactiveElements = screen.getAllByRole("button");

    // Tab through all interactive elements
    for (let i = 0; i < interactiveElements.length; i++) {
      await user.tab();
    }

    // Tab should cycle back to first element (focus trap)
    await user.tab();
    expect(document.activeElement).toBe(interactiveElements[0]);
  });
});
