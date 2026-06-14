/**
 * Smoke tests for the super-admin finance page (issue #206).
 *
 * The page is gated only by the `(admin)` layout's super_admin check —
 * there is no per-feature flag any more (retired in issue #493).
 * Remaining coverage:
 *   1. Seed data → dashboard renders with the page title.
 *   2. No data → empty-state copy renders without throwing (charts must
 *      not crash on a zero-volume window).
 */

import { render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";

import type { FinanceSummary } from "@/models/superadmin-finance";

const fetchSummaryMock = vi.fn<(client: unknown, params: unknown) => Promise<FinanceSummary>>();

vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string, values?: Record<string, string | number>) =>
    values ? `${key} ${JSON.stringify(values)}` : key,
  getLocale: async () => "en",
}));

vi.mock("@/lib/api/client-server", () => ({
  createServerApiClient: async () => ({}),
}));

const buildSummaryCsvUrlMock = vi.fn(
  (_client: unknown, params: { period: string; currency?: string; tenantId?: string }) => {
    const q = new URLSearchParams({ period: params.period });
    if (params.currency) q.set("currency", params.currency);
    if (params.tenantId) q.set("tenantId", params.tenantId);
    return `https://api.test/v1/superadmin/finance/summary.csv?${q.toString()}`;
  },
);

vi.mock("@/services/SuperAdminFinanceService", () => ({
  SuperAdminFinanceService: {
    fetchSummary: (...args: [unknown, unknown]) => fetchSummaryMock(...args),
    launchSurvey: vi.fn(),
    buildSummaryCsvUrl: (...args: [unknown, { period: string }]) => buildSummaryCsvUrlMock(...args),
  },
}));

// The browser API client is reached by the client component on period
// switch; we stub it so the test never tries a real fetch.
vi.mock("@/lib/api/client-browser", () => ({
  createClientApiClient: () => ({
    get: vi.fn(),
    post: vi.fn(),
  }),
}));

vi.mock("@/components/ui/toast", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
  Toaster: () => null,
}));

function buildSummary(overrides?: Partial<FinanceSummary>): FinanceSummary {
  return {
    period: {
      from: "2026-04-24",
      to: "2026-05-24",
      label: "30d",
      comparisonFrom: "2026-03-25",
      comparisonTo: "2026-04-24",
    },
    kpis: {
      volumeCents: 128_453_000,
      platformFeeCents: 2_319_240,
      stripeFeeCents: 1_847_215,
      donorCount: 13_080,
      refundedVolumeCents: 540_000,
      recurringMrrCents: 1_487_000,
      activeTenantsCount: 41,
      paymentFailureRate: 2.7,
      hhi: 0.11,
      deltas: {
        volumePercent: 18.2,
        platformFeePercent: 17.1,
        stripeFeePercent: 12.4,
        donorCountPercent: 8.3,
        refundedVolumePercent: -2.1,
        recurringMrrPercent: 3.2,
      },
    },
    mobilisation: {
      platformGrade: "A",
      platformScore: 76,
      components: { activation: 70, recurrence: 65, scale: 80, growth: 78, diversity: 82 },
      perTenant: [
        {
          tenantId: "00000000-0000-0000-0000-000000000001",
          tenantName: "ACME NPO",
          grade: "A",
          score: 76,
          components: { activation: 70, recurrence: 65, scale: 80, growth: 78, diversity: 82 },
          isAnonymised: false,
        },
      ],
    },
    surveys: [],
    timeseries: [
      { date: "2026-04-24", volumeCents: 2_000_000, platformFeeCents: 36_000 },
      { date: "2026-05-23", volumeCents: 7_800_000, platformFeeCents: 140_400 },
    ],
    perTenant: [
      {
        tenantId: "00000000-0000-0000-0000-000000000001",
        tenantName: "ACME NPO",
        volumeCents: 28_025_000,
        platformFeeCents: 505_600,
        donationCount: 1_240,
      },
    ],
    perCurrency: [{ currency: "EUR", volumeCents: 128_453_000, donationCount: 13_080 }],
    ...overrides,
  };
}

function emptySummary(): FinanceSummary {
  return buildSummary({
    kpis: {
      volumeCents: 0,
      platformFeeCents: 0,
      stripeFeeCents: null,
      donorCount: 0,
      refundedVolumeCents: 0,
      recurringMrrCents: 0,
      activeTenantsCount: 0,
      paymentFailureRate: null,
      hhi: 0,
      deltas: {
        volumePercent: 0,
        platformFeePercent: 0,
        stripeFeePercent: null,
        donorCountPercent: 0,
        refundedVolumePercent: 0,
        recurringMrrPercent: 0,
      },
    },
    perTenant: [],
    perCurrency: [],
    timeseries: [],
    mobilisation: {
      platformGrade: null,
      platformScore: null,
      components: { activation: 0, recurrence: 0, scale: 0, growth: 0, diversity: 0 },
      perTenant: [],
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("/admin/finance — dashboard render", () => {
  it("renders the dashboard when the summary fetch succeeds", async () => {
    fetchSummaryMock.mockResolvedValue(buildSummary());
    const { default: FinancePage } = await import("../page");
    const tree = await FinancePage();
    const { container } = render(tree);
    await waitFor(() => {
      // After the i18n migration (#443 follow-up) the dashboard renders
      // through `useTranslations("admin.finance")`. The test mock uses
      // the EN locale, so the H1 reads `pageTitlePrefix` + `pageTitleEm`
      // = "Platform finance" (was "Finance plateforme" pre-migration).
      expect(container.querySelector("h1")?.textContent).toBe("Platform finance");
    });
    expect(fetchSummaryMock).toHaveBeenCalledTimes(1);
  });

  it("Export button click builds the CSV URL with current filters + triggers anchor download (#442)", async () => {
    fetchSummaryMock.mockResolvedValue(buildSummary());
    const { default: FinancePage } = await import("../page");
    const tree = await FinancePage();
    render(tree);

    const exportBtn = await screen.findByRole("button", { name: /Export/i });
    expect(exportBtn).toBeInTheDocument();
    expect(exportBtn).not.toBeDisabled();

    // Spy on every synthetic anchor click so we can assert the
    // download was actually triggered (we replaced the earlier
    // `window.location.assign` path with an `<a download>` click).
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    await user.click(exportBtn);

    expect(buildSummaryCsvUrlMock).toHaveBeenCalledTimes(1);
    const params = buildSummaryCsvUrlMock.mock.calls[0]?.[1];
    expect(params).toMatchObject({ period: "30d" });
    // `"all"` filters are stripped to undefined — the API treats absence
    // as "all", so a literal `currency=all` would be a 400.
    expect(params?.currency).toBeUndefined();
    expect(params?.tenantId).toBeUndefined();

    expect(clickSpy).toHaveBeenCalledTimes(1);
    clickSpy.mockRestore();
  });
});

describe("/admin/finance — empty state", () => {
  it("renders the friendly empty-state copy when the period has no data", async () => {
    fetchSummaryMock.mockResolvedValue(emptySummary());
    const { default: FinancePage } = await import("../page");
    const tree = await FinancePage();
    render(tree);
    // Empty-state body — `admin.finance.empty.title` in en.json.
    expect(await screen.findByText(/No data for this period/)).toBeInTheDocument();
  });
});
