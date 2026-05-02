import { ImpersonationService } from "@/services/ImpersonationService";
import { render, screen, userEvent, waitFor } from "@/tests/test-utils";

import { StartImpersonationForm } from "./start-impersonation-form";

vi.mock("@/services/ImpersonationService", () => ({
  ImpersonationService: {
    listTenants: vi.fn(),
    searchTargets: vi.fn(),
  },
}));

vi.mock("@/lib/api/client-browser", () => ({
  createClientApiClient: vi.fn(() => ({})),
}));

const TARGET = {
  id: "00000000-0000-0000-0000-0000000aaaaa",
  keycloakId: "00000000-0000-0000-0000-0000000aa101",
  firstName: "Target",
  lastName: "User",
  email: "target@example.org",
  role: "org_admin",
  tenantId: "tenant-1",
  tenantName: "Test Tenant",
  tenantSlug: "test-tenant",
};

/**
 * Issue #250 — the form's discriminator branching on the API's 401
 * response shape (`step_up_required: true` redirects through Keycloak;
 * `false` renders a localised lockout error). Without this test, a
 * regression that re-keys off `body.detail` again — the original #250
 * bug — would ship green because every other layer is happy.
 *
 * jsdom's `window.location` is non-configurable; the memory-archived
 * `Object.defineProperty(window, "location", { writable: true, value: ... })`
 * pattern is what works, NOT `vi.spyOn(window.location, "assign")`.
 */
describe("StartImpersonationForm — step-up 401 handling (issue #250)", () => {
  let originalLocation: Location;
  let assignMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalLocation = window.location;
    assignMock = vi.fn();
    Object.defineProperty(window, "location", {
      writable: true,
      configurable: true,
      value: {
        ...originalLocation,
        origin: "https://app.givernance.org",
        assign: assignMock,
      },
    });
    vi.mocked(ImpersonationService.listTenants).mockResolvedValue({ data: [] });
    vi.mocked(ImpersonationService.searchTargets).mockResolvedValue({ data: [TARGET] });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      writable: true,
      configurable: true,
      value: originalLocation,
    });
    vi.restoreAllMocks();
  });

  async function fillAndSubmit() {
    const user = userEvent.setup();
    render(<StartImpersonationForm />);

    // Open target picker, pick the seeded user
    await user.click(screen.getByRole("button", { name: /Search a user/i }));
    await user.click(await screen.findByText("Target User"));

    // Fill reason (≥ 20 chars to pass client-side validation)
    await user.type(
      screen.getByLabelText(/Reason/i),
      "Reproducing a bug in the donations export — ticket #5678",
    );
    await user.click(screen.getByRole("button", { name: /Start session/i }));
    return user;
  }

  it("step_up_required=true → window.location.assign with /api/auth/login?acr_values=2", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({
        type: "https://httpproblems.com/http-status/401",
        title: "Unauthorized",
        status: 401,
        detail: "Step-up authentication required — re-authenticate with MFA and retry.",
        reason: "acr_insufficient",
        step_up_required: true,
      }),
    });

    await fillAndSubmit();

    await waitFor(() => expect(assignMock).toHaveBeenCalledTimes(1));
    const firstCall = assignMock.mock.calls[0];
    if (!firstCall) throw new Error("expected assign() to have been called");
    const target = new URL(firstCall[0] as string);
    expect(target.origin).toBe("https://app.givernance.org");
    expect(target.pathname).toBe("/api/auth/login");
    expect(target.searchParams.get("acr_values")).toBe("2");
    expect(target.searchParams.get("prompt")).toBe("login");
    expect(target.searchParams.get("return_to")).toBe("/admin/impersonation/new");
  });

  it("step_up_required=false (lockout) → no redirect, lockout error rendered", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({
        type: "https://httpproblems.com/http-status/401",
        title: "Unauthorized",
        status: 401,
        detail: "Step-up authentication failed and account is now locked.",
        reason: "acr_insufficient",
        step_up_required: false,
      }),
    });

    await fillAndSubmit();

    // Lockout error from the i18n bundle, NOT the API's English `detail`.
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/temporarily locked/i));
    expect(assignMock).not.toHaveBeenCalled();
  });
});
