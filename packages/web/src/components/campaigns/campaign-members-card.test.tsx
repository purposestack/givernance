// @ts-nocheck
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import { createClientApiClient } from "@/lib/api/client-browser";
import { PostalCampaignService } from "@/services/PostalCampaignService";

import { CampaignMembersCard } from "./campaign-members-card";

// Mock next-intl
vi.mock("next-intl", () => ({
  useLocale: () => "fr",
  useTranslations: () => (key: string) => {
    const translations: Record<string, string | Record<string, string>> = {
      title: "Campaign Members",
      description: "Manage recipients for your postal campaign",
      empty: "No members added yet",
      doorDropExplanation: "Door drop campaigns don't have specific recipients",
      "actions.add": "Add Members",
      "actions.addFiltered": "Advanced Filters",
      "actions.remove": "Remove",
      "toast.added": "{count, plural, =1 {# member} other {# members}} added",
      "toast.removed": "Member removed",
      "toast.removeFailed": "Failed to remove member",
      "dialog.title": "Add Members",
      "dialog.description": "Search and select constituents to add",
      "dialog.searchPlaceholder": "Search by name or email...",
      "dialog.loading": "Loading...",
      "dialog.empty": "No results found",
      "dialog.cancel": "Cancel",
      "dialog.confirm": "Add {count} selected",
      "dialog.submitting": "Adding...",
      "dialog.error": "Failed to add members",
      "filterDialog.title": "Add Members with Filters",
      "filterDialog.description": "Use advanced filters to select constituents",
      "filterDialog.filterBuilderLoading": "Loading filter builder...",
      "filterDialog.previewLoading": "Calculating matches...",
      "filterDialog.previewEmpty": "No constituents match your filters",
      "filterDialog.previewTooMany": "Too many matches ({count}). Please refine your filters.",
      "filterDialog.previewCount": "{count} constituents will be added",
      "filterDialog.cancel": "Cancel",
      "filterDialog.confirm": "Add {count} constituents",
      "filterDialog.submitting": "Adding constituents...",
      "filterDialog.success": "Added {added} constituents ({skipped} skipped)",
      "filterDialog.error": "Failed to add constituents",
    };
    return translations[key] || key;
  },
}));

vi.mock("@/lib/api/client-browser", () => ({
  createClientApiClient: vi.fn(),
}));

vi.mock("@/services/PostalCampaignService", () => ({
  PostalCampaignService: {
    listMembers: vi.fn(),
    addMembers: vi.fn(),
    removeMember: vi.fn(),
    addMembersFromFilter: vi.fn(),
  },
}));

vi.mock("@/services/ConstituentService", () => ({
  ConstituentService: {
    listConstituents: vi.fn(),
  },
}));

// Mock toast
vi.mock("@/components/ui/toast", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const mockMembers = [
  {
    id: "1",
    constituentId: "c1",
    firstName: "John",
    lastName: "Doe",
    email: "john@example.com",
    type: "individual",
    addedAt: "2024-01-01",
    campaignDonationCents: 0,
  },
];

describe("CampaignMembersCard", () => {
  const defaultProps = {
    campaignId: "campaign123",
    initialMembers: mockMembers,
    initialTotal: 1,
    doorDrop: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the member list", () => {
    render(<CampaignMembersCard {...defaultProps} />);

    expect(screen.getByText("Campaign Members")).toBeInTheDocument();
    expect(screen.getByText("John Doe")).toBeInTheDocument();
    expect(screen.getByText("john@example.com")).toBeInTheDocument();
  });

  it("shows door drop explanation for door drop campaigns", () => {
    render(<CampaignMembersCard {...defaultProps} doorDrop />);

    expect(
      screen.getByText("Door drop campaigns don't have specific recipients"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Add Members")).not.toBeInTheDocument();
  });

  // TODO(#421): jsdom + Radix Dialog interaction is flaky; rewrite as a Playwright e2e.
  it.skip("opens the add members dialog", () => {
    render(<CampaignMembersCard {...defaultProps} />);

    const addButton = screen.getByText("Add Members");
    fireEvent.click(addButton);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Search and select constituents to add")).toBeInTheDocument();
  });

  // TODO(#421): jsdom + Radix Dialog interaction is flaky; rewrite as a Playwright e2e.
  it.skip("opens the advanced filters dialog", () => {
    render(<CampaignMembersCard {...defaultProps} />);

    const filterButton = screen.getByText("Advanced Filters");
    fireEvent.click(filterButton);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Add Members with Filters")).toBeInTheDocument();
  });

  it("removes a member", async () => {
    const mockClient = {
      baseUrl: "",
      defaultHeaders: {},
      fetchFn: vi.fn(),
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
      request: vi.fn(),
      withHeaders: vi.fn(),
      withInterceptor: vi.fn(),
    } as unknown as ReturnType<typeof createClientApiClient>;
    vi.mocked(createClientApiClient).mockReturnValue(mockClient);
    vi.mocked(PostalCampaignService.removeMember).mockResolvedValue({ removed: true });

    const onTotalChanged = vi.fn();

    render(<CampaignMembersCard {...defaultProps} onTotalChanged={onTotalChanged} />);

    const removeButton = screen.getByRole("button", { name: "Remove" });
    fireEvent.click(removeButton);

    await waitFor(() => {
      expect(PostalCampaignService.removeMember).toHaveBeenCalledWith(
        mockClient,
        "campaign123",
        "c1",
      );
      expect(onTotalChanged).toHaveBeenCalledWith(0);
    });
  });

  // TODO(#421): jsdom + Radix Dialog interaction is flaky; rewrite as a Playwright e2e.
  it.skip("adds members from filter", async () => {
    const mockClient = {
      baseUrl: "",
      defaultHeaders: {},
      fetchFn: vi.fn(),
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
      request: vi.fn(),
      withHeaders: vi.fn(),
      withInterceptor: vi.fn(),
    } as unknown as ReturnType<typeof createClientApiClient>;
    vi.mocked(createClientApiClient).mockReturnValue(mockClient);
    vi.mocked(PostalCampaignService.addMembersFromFilter).mockResolvedValue({
      added: 5,
      skipped: 1,
    });
    vi.mocked(PostalCampaignService.listMembers).mockResolvedValue({
      data: [...mockMembers],
      pagination: { page: 1, perPage: 25, total: 6, totalPages: 1 },
    });

    // Mock FilterBuilder component
    (window as unknown as { FilterBuilder: React.FC<Record<string, unknown>> }).FilterBuilder = ({
      onChange,
      previewCount,
    }: {
      onChange: (q: Record<string, unknown>) => void;
      previewCount: number;
    }) => (
      <div>
        <button
          type="button"
          onClick={() =>
            onChange({
              operator: "AND",
              conditions: [{ id: "1", field: "type", operator: "eq", value: "individual" }],
            })
          }
        >
          Set Filter
        </button>
        {previewCount && <div>Preview: {previewCount}</div>}
      </div>
    );

    render(<CampaignMembersCard {...defaultProps} />);

    // Open filter dialog
    const filterButton = screen.getByText("Advanced Filters");
    fireEvent.click(filterButton);

    // Set a filter
    const setFilterButton = screen.getByText("Set Filter");
    fireEvent.click(setFilterButton);

    // Simulate preview count
    await waitFor(() => {
      expect(screen.getByText(/constituents will be added/)).toBeInTheDocument();
    });

    // Confirm adding
    const confirmButton = screen.getByRole("button", { name: /Add \d+ constituents/ });
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(PostalCampaignService.addMembersFromFilter).toHaveBeenCalledWith(
        mockClient,
        "campaign123",
        expect.objectContaining({
          operator: "AND",
          conditions: expect.arrayContaining([
            expect.objectContaining({ field: "type", operator: "eq", value: "individual" }),
          ]),
        }),
      );
    });

    delete (window as unknown as { FilterBuilder: React.FC<Record<string, unknown>> })
      .FilterBuilder;
  });
});
