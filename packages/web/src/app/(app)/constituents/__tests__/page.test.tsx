/**
 * Constituents list page — basic "More filters" passthrough (issue #614).
 *
 * With `advanced_filters` off (the default) the "More filters" dialog is the
 * only filter entry point. It writes `lastDonationFrom` / `lastDonationTo` /
 * `minLifetimeAmountCents` to the URL; before the fix the page read them for
 * the active-state dot but never forwarded them to the API, so the dialog
 * filtered nothing.
 */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listConstituentsMock = vi.fn();
const isFlagEnabledMock = vi.fn<(flags: unknown, key: string) => boolean>(() => false);

const redirectMock = vi.fn((href: string) => {
  // Mirror Next: `redirect()` never returns.
  throw new Error(`NEXT_REDIRECT:${href}`);
});

vi.mock("next/navigation", () => ({
  redirect: (href: string) => redirectMock(href),
}));

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
  isFlagEnabled: (flags: unknown, key: string) => isFlagEnabledMock(flags, key),
}));

vi.mock("@/components/shared/custom-fields", () => ({
  fetchCustomFieldDefinitionsOrEmpty: async () => [],
}));

vi.mock("@/services/ConstituentService", () => ({
  ConstituentService: {
    listConstituents: (...args: unknown[]) => listConstituentsMock(...args),
  },
}));

vi.mock("@/components/shared/page-header", () => ({
  PageHeader: ({ title }: { title: string }) => <header>{title}</header>,
}));

vi.mock("@/components/constituents/bulk-import-trigger", () => ({
  BulkImportTrigger: () => null,
}));

vi.mock("../constituents-table", () => ({
  ConstituentsTable: () => <div data-testid="constituents-table" />,
}));

async function renderPage(params: Record<string, string>) {
  const { default: ConstituentsPage } = await import("../page");
  const tree = await ConstituentsPage({ searchParams: Promise.resolve(params) });
  return render(tree);
}

function lastListQuery(): Record<string, unknown> {
  const call = listConstituentsMock.mock.calls.at(-1);
  return (call?.[1] ?? {}) as Record<string, unknown>;
}

describe("ConstituentsPage — basic More filters passthrough", () => {
  beforeEach(() => {
    listConstituentsMock.mockReset();
    listConstituentsMock.mockResolvedValue({
      data: [],
      pagination: { page: 1, perPage: 20, total: 0, totalPages: 0 },
    });
    isFlagEnabledMock.mockReset();
    isFlagEnabledMock.mockReturnValue(false);
  });

  it("forwards the validated dialog params to the API when advanced_filters is off", async () => {
    await renderPage({
      lastDonationFrom: "2026-01-01T00:00:00.000Z",
      lastDonationTo: "2026-06-30T23:59:59.999Z",
      minLifetimeAmountCents: "50000",
    });

    expect(lastListQuery()).toMatchObject({
      lastDonationFrom: "2026-01-01T00:00:00.000Z",
      lastDonationTo: "2026-06-30T23:59:59.999Z",
      minLifetimeAmountCents: 50000,
    });
    // Zero results reached through a filter keep the table chrome mounted.
    expect(screen.getByTestId("constituents-table")).toBeInTheDocument();
  });

  it("drops hand-mangled values instead of round-tripping them into a 400", async () => {
    await renderPage({
      lastDonationFrom: "yesterday",
      lastDonationTo: "2026-13-45",
      minLifetimeAmountCents: "-12.5",
    });

    const query = lastListQuery();
    expect(query.lastDonationFrom).toBeUndefined();
    expect(query.lastDonationTo).toBeUndefined();
    expect(query.minLifetimeAmountCents).toBeUndefined();
  });

  it("does not forward the dialog params when advanced_filters is on (FilterBuilder replaces the dialog)", async () => {
    isFlagEnabledMock.mockImplementation((_flags, key) => key === "advanced_filters");
    await renderPage({
      lastDonationFrom: "2026-01-01T00:00:00.000Z",
      minLifetimeAmountCents: "50000",
    });

    const query = lastListQuery();
    expect(query.lastDonationFrom).toBeUndefined();
    expect(query.minLifetimeAmountCents).toBeUndefined();
  });
});

describe("ConstituentsPage — page past the last one (issue #614)", () => {
  beforeEach(() => {
    redirectMock.mockClear();
    isFlagEnabledMock.mockReset();
    isFlagEnabledMock.mockReturnValue(false);
  });

  it("redirects to the last real page, preserving the other params", async () => {
    listConstituentsMock.mockReset();
    listConstituentsMock.mockResolvedValue({
      data: [],
      pagination: { page: 9, perPage: 20, total: 45, totalPages: 3 },
    });

    await expect(renderPage({ page: "9", search: "dupont" })).rejects.toThrow(
      "NEXT_REDIRECT:/constituents?search=dupont&page=3",
    );
  });

  it("does not redirect a genuinely empty list", async () => {
    listConstituentsMock.mockReset();
    listConstituentsMock.mockResolvedValue({
      data: [],
      pagination: { page: 4, perPage: 20, total: 0, totalPages: 0 },
    });

    await renderPage({ page: "4" });
    expect(redirectMock).not.toHaveBeenCalled();
  });
});
