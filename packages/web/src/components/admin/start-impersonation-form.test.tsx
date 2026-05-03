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
    // Clear the post-MFA stash so a previous test's redirect-branch
    // sessionStorage write doesn't auto-resubmit the next mount and
    // pre-fill the form (the form's mount-effect reads `gv-impersonation
    // -resubmit` and re-fires the fetch when present).
    sessionStorage.clear();
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

/**
 * Locks the post-MFA auto-resubmit (PR #251 dev-feedback). The MFA
 * round-trip used to drop the operator back on an empty form and force
 * them to refill target / mode / reason. The form now stashes the
 * payload before the redirect and resubmits on the next mount.
 *
 * This test covers the "after KC drop-back" path:
 *   1. Pre-populate sessionStorage with a fresh stash (as the redirect
 *      branch would have done).
 *   2. Mount the form.
 *   3. Expect the fetch to fire automatically with the stashed payload.
 *   4. Expect the stash to be cleared (single-use — a refresh must not
 *      stamp a second session).
 */
describe("StartImpersonationForm — post-MFA auto-resubmit (issue #251 dev-feedback)", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.mocked(ImpersonationService.listTenants).mockResolvedValue({ data: [] });
    vi.mocked(ImpersonationService.searchTargets).mockResolvedValue({ data: [TARGET] });
  });

  afterEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("picks up a fresh sessionStorage stash on mount, hydrates state, and shows the Resume CTA WITHOUT auto-firing the fetch", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    sessionStorage.setItem(
      "gv-impersonation-resubmit",
      JSON.stringify({
        target: TARGET,
        mode: "delegation",
        reason: "Reproducing receipt PDF download issue — ticket #5678",
        expiresAt: Date.now() + 60_000,
      }),
    );

    render(<StartImpersonationForm />);

    // The Resume banner appears (region with the title), the fetch does
    // NOT fire — multi-agent review I-4 (PR #251) wanted the operator
    // to confirm intent after the MFA round-trip rather than have the
    // session start under their feet.
    const resumeBtn = await screen.findByRole("button", { name: /Resume session/i });
    expect(resumeBtn).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    // Single-use — stash is removed on mount regardless of whether the
    // operator clicks Resume or Cancel, so a refresh leaves the form in
    // its normal empty state.
    expect(sessionStorage.getItem("gv-impersonation-resubmit")).toBeNull();
  });

  it("clicking Resume fires the fetch with the hydrated payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        data: { sessionId: "sess-1", token: "tok", mode: "delegation" },
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    sessionStorage.setItem(
      "gv-impersonation-resubmit",
      JSON.stringify({
        target: TARGET,
        mode: "delegation",
        reason: "Reproducing receipt PDF download issue — ticket #5678",
        expiresAt: Date.now() + 60_000,
      }),
    );

    const user = userEvent.setup();
    render(<StartImpersonationForm />);
    const resumeBtn = await screen.findByRole("button", { name: /Resume session/i });
    await user.click(resumeBtn);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      targetUserId: TARGET.id,
      mode: "delegation",
      reason: "Reproducing receipt PDF download issue — ticket #5678",
    });
  });

  it("clicking Cancel discards the hydrated payload and the fetch never fires", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    sessionStorage.setItem(
      "gv-impersonation-resubmit",
      JSON.stringify({
        target: TARGET,
        mode: "delegation",
        reason: "Reproducing receipt PDF download issue — ticket #5678",
        expiresAt: Date.now() + 60_000,
      }),
    );

    const user = userEvent.setup();
    render(<StartImpersonationForm />);
    const cancelBtn = await screen.findByRole("button", { name: "Cancel" });
    await user.click(cancelBtn);

    expect(fetchMock).not.toHaveBeenCalled();
    // After cancel, the Resume banner is gone — operator can pick a
    // different target/mode/reason from a clean slate.
    expect(screen.queryByRole("button", { name: /Resume session/i })).toBeNull();
  });

  it("ignores a stale stash (past TTL) without resubmitting", async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    sessionStorage.setItem(
      "gv-impersonation-resubmit",
      JSON.stringify({
        target: TARGET,
        mode: "delegation",
        reason: "stale stash from yesterday's session",
        expiresAt: Date.now() - 60_000, // expired 1 min ago
      }),
    );

    render(<StartImpersonationForm />);

    // Give the mount-effect a tick to fire (or not).
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchMock).not.toHaveBeenCalled();
    // Stale stash is still cleaned up — single-use applies even on
    // expiry, so a page refresh doesn't keep tripping the same dead
    // entry.
    expect(sessionStorage.getItem("gv-impersonation-resubmit")).toBeNull();
  });
});
