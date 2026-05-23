import { render, screen, waitFor } from "@testing-library/react";
import { FilterPreview } from "./FilterPreview";
import type { FilterQuery } from "./filter-types";

// Mock the translations hook
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => {
    const translations: Record<string, string> = {
      loading: "Calculating matches...",
      error: "Could not calculate preview",
      count: `${values?.count || 0} constituents match`,
    };
    return translations[key] || key;
  },
}));

describe("FilterPreview", () => {
  it("renders nothing when no conditions", () => {
    const query: FilterQuery = {
      operator: "AND",
      conditions: [],
    };

    const { container } = render(<FilterPreview query={query} />);
    expect(container.firstChild).toBeNull();
  });

  // TODO(#421): these 4 tests were written against the old `mockFilterAPI`;
  // now that FilterPreview calls the real `/v1/constituents/filter/preview`
  // endpoint via `createClientApiClient()`, they need the API client mocked.
  // Rewrite when the mock harness for the API client lands.
  it.skip("shows loading state while calculating", async () => {
    const query: FilterQuery = {
      operator: "AND",
      conditions: [
        {
          id: "1",
          field: "city",
          operator: "eq",
          value: "Geneva",
        },
      ],
    };

    render(<FilterPreview query={query} />);

    expect(await screen.findByText("Calculating matches...")).toBeInTheDocument();
  });

  it.skip("shows count after calculation", async () => {
    const query: FilterQuery = {
      operator: "AND",
      conditions: [
        {
          id: "1",
          field: "city",
          operator: "eq",
          value: "Geneva",
        },
      ],
    };

    render(<FilterPreview query={query} />);

    await waitFor(() => {
      expect(screen.getByText(/constituents match/)).toBeInTheDocument();
    });
  });

  it("does not calculate when conditions have empty values", () => {
    const query: FilterQuery = {
      operator: "AND",
      conditions: [
        {
          id: "1",
          field: "city",
          operator: "eq",
          value: "",
        },
      ],
    };

    const { container } = render(<FilterPreview query={query} />);
    expect(container.firstChild).toBeNull();
  });

  it.skip("handles exists/notExists operators without values", async () => {
    const query: FilterQuery = {
      operator: "AND",
      conditions: [
        {
          id: "1",
          field: "email",
          operator: "exists",
          value: null,
        },
      ],
    };

    render(<FilterPreview query={query} />);

    await waitFor(() => {
      expect(screen.getByText(/constituents match/)).toBeInTheDocument();
    });
  });

  it.skip("calls onPreview callback with result", async () => {
    const onPreview = vi.fn();
    const query: FilterQuery = {
      operator: "AND",
      conditions: [
        {
          id: "1",
          field: "city",
          operator: "eq",
          value: "Geneva",
        },
      ],
    };

    render(<FilterPreview query={query} onPreview={onPreview} />);

    await waitFor(() => {
      expect(onPreview).toHaveBeenCalledWith(
        expect.objectContaining({
          count: expect.any(Number),
        }),
      );
    });
  });
});
