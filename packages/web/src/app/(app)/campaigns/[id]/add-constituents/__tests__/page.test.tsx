/**
 * Add-constituents page — guard + `advanced_filters` off-state (issue #614).
 *
 * - The recipient endpoints are `requireOrgAdmin` (docs/23 §7), so the page
 *   guard must be org-admin too — a `write` guard let role `user` in only to
 *   hit a guaranteed 403 on submit.
 * - With `advanced_filters` off, the "Advanced filters" card must be
 *   completely absent (its preview / bulk-add endpoints 404).
 */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireOrgAdminMock = vi.fn(async () => ({ roles: ["org_admin"] }));
const isFlagEnabledMock = vi.fn<(flags: unknown, key: string) => boolean>(() => false);

vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string, values?: Record<string, string | number>) =>
    values ? `${key} ${JSON.stringify(values)}` : key,
}));

vi.mock("@/lib/auth/guards", () => ({
  requireOrgAdmin: () => requireOrgAdminMock(),
}));

vi.mock("@/lib/api/client-server", () => ({
  createServerApiClient: async () => ({}),
}));

vi.mock("@/services/FeatureFlagsService", () => ({
  FeatureFlagsService: { listPublic: async () => [] },
  isFlagEnabled: (flags: unknown, key: string) => isFlagEnabledMock(flags, key),
}));

vi.mock("@/services/CampaignService", () => ({
  CampaignService: {
    getCampaign: async () => ({ id: "c1", name: "Spring appeal", type: "nominative_postal" }),
  },
}));

vi.mock("@/components/shared/page-header", () => ({
  PageHeader: ({ title }: { title: string }) => <header>{title}</header>,
}));

vi.mock("../add-constituents-content", () => ({
  AddConstituentsContent: ({ mode }: { mode: string }) => <div data-testid={`content-${mode}`} />,
}));

async function renderPage() {
  const { default: AddConstituentsPage } = await import("../page");
  const tree = await AddConstituentsPage({ params: Promise.resolve({ id: "c1" }) });
  return render(tree);
}

describe("AddConstituentsPage", () => {
  beforeEach(() => {
    requireOrgAdminMock.mockClear();
    isFlagEnabledMock.mockReset();
    isFlagEnabledMock.mockReturnValue(false);
  });

  it("is guarded by requireOrgAdmin, matching the API contract", async () => {
    await renderPage();
    expect(requireOrgAdminMock).toHaveBeenCalledTimes(1);
  });

  it("renders no Advanced filters card when advanced_filters is off", async () => {
    await renderPage();

    expect(screen.queryByText("advancedFilters.title")).not.toBeInTheDocument();
    expect(screen.queryByTestId("content-filter")).not.toBeInTheDocument();
    expect(screen.getByTestId("content-search")).toBeInTheDocument();
  });

  it("renders the Advanced filters card when advanced_filters is on", async () => {
    isFlagEnabledMock.mockImplementation((_flags, key) => key === "advanced_filters");
    await renderPage();

    expect(screen.getByText("advancedFilters.title")).toBeInTheDocument();
    expect(screen.getByTestId("content-filter")).toBeInTheDocument();
    expect(screen.getByTestId("content-search")).toBeInTheDocument();
  });
});
