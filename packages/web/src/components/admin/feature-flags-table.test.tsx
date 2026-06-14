import { ApiProblem } from "@/lib/api";
import { FeatureFlagsService } from "@/services/FeatureFlagsService";
import { mockToast, render, screen, userEvent, waitFor } from "@/tests/test-utils";

import { FeatureFlagsTable } from "./feature-flags-table";

/**
 * Render + optimistic toggle test for the super-admin Back Office
 * surface (PR #352 / @magino follow-up). The component owns
 * optimistic UI: clicking the toggle flips the local state IMMEDIATELY,
 * fires `FeatureFlagsService.setEnabled`, and rolls back on error.
 * The QA review (M3) called the optimistic+rollback path "non-trivial
 * logic with zero tests" — pin both branches here.
 */
vi.mock("@/services/FeatureFlagsService", () => ({
  FeatureFlagsService: {
    setEnabled: vi.fn(),
  },
  isFlagEnabled: vi.fn(),
}));

vi.mock("@/lib/api/client-browser", () => ({
  createClientApiClient: () => ({}),
}));

const baseRow = {
  key: "communication.bulk_email",
  enabled: false,
  label: "Bulk emails to constituents",
  description:
    "Lets operators send one email to several constituents at once from the Constituents page.",
  scope: "platform" as const,
  tenantOverrideAllowed: false,
  public: true,
  updatedBy: null,
  createdAt: "2026-05-10T10:00:00.000Z",
  updatedAt: "2026-05-10T10:00:00.000Z",
  // overrideStats is null for platform-scoped flags that never carry
  // per-tenant overrides — the badge gracefully vanishes for those rows.
  // This fixture therefore exercises the no-badge render path
  // (per-tenant override coverage lives in the API integration tests).
  overrideStats: null,
};

describe("FeatureFlagsTable", () => {
  beforeEach(() => {
    vi.mocked(FeatureFlagsService.setEnabled).mockReset();
    mockToast.success.mockClear();
    mockToast.error.mockClear();
  });

  it("renders the friendly label as the heading, with the dotted key + description as supporting text", () => {
    render(<FeatureFlagsTable rows={[baseRow]} />);

    // The user-visible heading is the friendly `label`, NOT the
    // dotted `key`. The key still renders as a small subtitle so
    // engineers can correlate `audit_logs.action = PATCH:/…/:key`.
    expect(
      screen.getByRole("heading", { name: /Bulk emails to constituents/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("communication.bulk_email")).toBeInTheDocument();
    expect(screen.getByText(/send one email to several constituents/i)).toBeInTheDocument();
    // Default-disabled badge + Enable button (mirror of the toggle state).
    expect(screen.getByText("Disabled", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Enable/i })).toBeInTheDocument();
  });

  it("optimistically flips the button label on click + toasts success", async () => {
    const user = userEvent.setup();
    vi.mocked(FeatureFlagsService.setEnabled).mockResolvedValue({ ...baseRow, enabled: true });

    render(<FeatureFlagsTable rows={[baseRow]} />);

    await user.click(screen.getByRole("button", { name: /Enable/i }));

    // After the click, the optimistic flip means the button has
    // already become "Disable" before the API resolves.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Disable/i })).toBeInTheDocument();
    });
    expect(FeatureFlagsService.setEnabled).toHaveBeenCalledWith(
      expect.anything(),
      "communication.bulk_email",
      true,
    );
    expect(mockToast.success).toHaveBeenCalled();
  });

  it("rolls back the optimistic flip when the API call fails", async () => {
    const user = userEvent.setup();
    vi.mocked(FeatureFlagsService.setEnabled).mockRejectedValue(
      new ApiProblem({
        type: "https://httpproblems.com/http-status/500",
        title: "Internal Server Error",
        status: 500,
        detail: "boom",
      }),
    );

    render(<FeatureFlagsTable rows={[baseRow]} />);
    await user.click(screen.getByRole("button", { name: /Enable/i }));

    // After the rejection, the button label MUST have rolled back to
    // "Enable" — no stale optimistic state stranded.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Enable/i })).toBeInTheDocument();
    });
    expect(mockToast.error).toHaveBeenCalled();
  });

  it("renders the empty-state message when the registry is empty", () => {
    render(<FeatureFlagsTable rows={[]} />);
    expect(screen.getByText(/No feature flags registered\./)).toBeInTheDocument();
  });
});
