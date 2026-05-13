import { ApiProblem } from "@/lib/api";
import { FeatureFlagsService, type TenantFlagViewRow } from "@/services/FeatureFlagsService";
import { mockToast, render, screen, userEvent, waitFor } from "@/tests/test-utils";

import { OrgFeatureFlagsList } from "./org-feature-flags-list";

/**
 * Smoke + behaviour tests for the org-admin Feature flags self-service
 * list (Epic #365 / PR #366). Pins the optimistic flip + the "Use the
 * default" path that now calls DELETE rather than the PATCH-as-delete
 * emulation the first iteration of this PR shipped. Per QA review
 * recommendation 4 on PR #366.
 */
vi.mock("@/services/FeatureFlagsService", () => ({
  FeatureFlagsService: {
    setOrgOverride: vi.fn(),
    deleteOrgOverride: vi.fn(),
  },
}));

vi.mock("@/lib/api/client-browser", () => ({
  createClientApiClient: () => ({}),
}));

const TENANT_ROW: TenantFlagViewRow = {
  key: "test.demo_flag",
  label: "Notification digest",
  description: "Sends a weekly summary of donations and grant deadlines.",
  scope: "tenant",
  tenantOverrideAllowed: true,
  public: true,
  platformDefault: false,
  effectiveValue: false,
  override: null,
};

const TENANT_ROW_WITH_OVERRIDE: TenantFlagViewRow = {
  ...TENANT_ROW,
  effectiveValue: true,
  override: {
    tenantId: "00000000-0000-0000-0000-000000000001",
    flagKey: "test.demo_flag",
    value: true,
    reason: null,
    setBy: "00000000-0000-0000-0000-000000000099",
    setAt: "2026-05-12T10:00:00.000Z",
  },
};

describe("OrgFeatureFlagsList", () => {
  beforeEach(() => {
    vi.mocked(FeatureFlagsService.setOrgOverride).mockReset();
    vi.mocked(FeatureFlagsService.deleteOrgOverride).mockReset();
    mockToast.success.mockClear();
    mockToast.error.mockClear();
  });

  it("renders the row with the friendly label + description, no engineering jargon", () => {
    render(<OrgFeatureFlagsList initialRows={[TENANT_ROW]} />);
    expect(screen.getByRole("heading", { name: /Notification digest/i })).toBeInTheDocument();
    expect(screen.getByText(/Sends a weekly summary of donations/i)).toBeInTheDocument();
    // No dotted key should appear in the org-admin surface — that's a
    // super-admin / engineer concern only.
    expect(screen.queryByText("test.demo_flag")).not.toBeInTheDocument();
  });

  it("Turn-on optimistically flips the effective state + calls setOrgOverride", async () => {
    const user = userEvent.setup();
    vi.mocked(FeatureFlagsService.setOrgOverride).mockResolvedValue(
      TENANT_ROW_WITH_OVERRIDE.override!,
    );
    render(<OrgFeatureFlagsList initialRows={[TENANT_ROW]} />);

    await user.click(screen.getByRole("button", { name: /Turn on/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Turn off/i })).toBeInTheDocument();
    });
    expect(FeatureFlagsService.setOrgOverride).toHaveBeenCalledWith(
      expect.anything(),
      "test.demo_flag",
      { value: true },
    );
    expect(mockToast.success).toHaveBeenCalled();
  });

  it("Use-the-default calls DELETE (not PATCH-with-platform-default) per API review fix", async () => {
    const user = userEvent.setup();
    vi.mocked(FeatureFlagsService.deleteOrgOverride).mockResolvedValue(undefined);
    render(<OrgFeatureFlagsList initialRows={[TENANT_ROW_WITH_OVERRIDE]} />);

    await user.click(screen.getByRole("button", { name: /Use the default/i }));

    await waitFor(() => {
      expect(FeatureFlagsService.deleteOrgOverride).toHaveBeenCalledWith(
        expect.anything(),
        "test.demo_flag",
      );
    });
    // The PATCH-as-delete emulation MUST be gone — assert setOrgOverride
    // was NOT called with `value: platformDefault`.
    expect(FeatureFlagsService.setOrgOverride).not.toHaveBeenCalled();
    expect(mockToast.success).toHaveBeenCalled();
  });

  it("rolls back the optimistic flip when the API call fails", async () => {
    const user = userEvent.setup();
    vi.mocked(FeatureFlagsService.setOrgOverride).mockRejectedValue(
      new ApiProblem({
        type: "https://httpproblems.com/http-status/500",
        title: "Internal Server Error",
        status: 500,
        detail: "boom",
      }),
    );

    render(<OrgFeatureFlagsList initialRows={[TENANT_ROW]} />);
    await user.click(screen.getByRole("button", { name: /Turn on/i }));

    await waitFor(() => {
      expect(mockToast.error).toHaveBeenCalledWith("boom");
    });
    // Pre-click label restored.
    expect(screen.getByRole("button", { name: /Turn on/i })).toBeInTheDocument();
  });
});
