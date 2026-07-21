/**
 * Campaigns list page — empty-state gate tests.
 *
 * Regression coverage for the two-tier empty-state grammar shared with
 * donations + constituents:
 *
 * - org truly empty (total 0, no filters) → page-level "seed your first
 *   campaign" EmptyState, table unmounted;
 * - search/status filter with 0 results → CampaignsTable STAYS mounted
 *   (its search input + status select are the only way to clear the
 *   filter); the in-table emptyState renders instead.
 *
 * Before the fix the gate was `hasAny` only, so a zero-result search
 * unmounted the whole table — including its own search chrome.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const listCampaignsMock = vi.fn();

vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string, values?: Record<string, string | number>) =>
    values ? `${key} ${JSON.stringify(values)}` : key,
}));

vi.mock("@/lib/auth/guards", () => ({
  requireAuth: async () => ({ roles: ["org_user"] }),
  hasPermission: () => false,
}));

vi.mock("@/lib/api/client-server", () => ({
  createServerApiClient: async () => ({}),
}));

vi.mock("@/services/FeatureFlagsService", () => ({
  FeatureFlagsService: { listPublic: async () => [] },
  isFlagEnabled: () => false,
}));

vi.mock("@/components/shared/custom-fields", () => ({
  fetchCustomFieldDefinitionsOrEmpty: async () => [],
}));

vi.mock("@/services/CampaignService", () => ({
  CampaignService: {
    listCampaigns: (...args: unknown[]) => listCampaignsMock(...args),
    getCampaignStats: vi.fn(),
  },
}));

vi.mock("@/components/shared/page-header", () => ({
  PageHeader: ({ title }: { title: string }) => <header>{title}</header>,
}));

vi.mock("../campaigns-table", () => ({
  CampaignsTable: () => <div data-testid="campaigns-table" />,
}));

function emptyResult() {
  return {
    data: [],
    pagination: { page: 1, perPage: 20, total: 0, totalPages: 0 },
  };
}

async function renderPage(params: Record<string, string>) {
  const { default: CampaignsPage } = await import("../page");
  const tree = await CampaignsPage({ searchParams: Promise.resolve(params) });
  return render(tree);
}

describe("CampaignsPage — empty-state gate", () => {
  it("shows the page-level seed empty state when the org has no campaigns and no filters", async () => {
    listCampaignsMock.mockResolvedValue(emptyResult());
    await renderPage({});
    expect(screen.getByText("empty.seedHint")).toBeInTheDocument();
    expect(screen.queryByTestId("campaigns-table")).not.toBeInTheDocument();
  });

  it("keeps the table (and its search chrome) mounted when a search returns no results", async () => {
    listCampaignsMock.mockResolvedValue(emptyResult());
    await renderPage({ search: "no-such-campaign" });
    expect(screen.getByTestId("campaigns-table")).toBeInTheDocument();
    expect(screen.queryByText("empty.seedHint")).not.toBeInTheDocument();
  });

  it("keeps the table mounted when a status filter returns no results", async () => {
    listCampaignsMock.mockResolvedValue(emptyResult());
    await renderPage({ status: "closed" });
    expect(screen.getByTestId("campaigns-table")).toBeInTheDocument();
    expect(screen.queryByText("empty.seedHint")).not.toBeInTheDocument();
  });

  it("ignores an invalid status value (no filter applied → seed empty state)", async () => {
    listCampaignsMock.mockResolvedValue(emptyResult());
    await renderPage({ status: "bogus" });
    expect(screen.getByText("empty.seedHint")).toBeInTheDocument();
    expect(screen.queryByTestId("campaigns-table")).not.toBeInTheDocument();
  });

  it("renders the table when campaigns exist", async () => {
    listCampaignsMock.mockResolvedValue({
      data: [],
      pagination: { page: 1, perPage: 20, total: 3, totalPages: 1 },
    });
    await renderPage({});
    expect(screen.getByTestId("campaigns-table")).toBeInTheDocument();
  });
});
