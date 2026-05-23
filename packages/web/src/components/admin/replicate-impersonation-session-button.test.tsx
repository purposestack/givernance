import { render, screen, userEvent, waitFor } from "@/tests/test-utils";

import { ReplicateImpersonationSessionButton } from "./replicate-impersonation-session-button";

/**
 * Issue #428 — one-click Replicate row-action on the past-sessions list.
 *
 * The button piggy-backs on the start-form's existing post-MFA stash
 * machinery (`gv-impersonation-resubmit`) so that a stale step-up
 * bounces through `/api/auth/login` → Keycloak MFA → `/admin/impersonation/new`
 * (the Resume banner picks up). These tests pin the three 401 branches
 * plus the happy-path navigation, and lock the " (replicated)" reason
 * marker that audit-log readers correlate on.
 *
 * jsdom's `window.location` is non-configurable; we replace it via
 * `Object.defineProperty(...)` per the memory-archived pattern, not
 * `vi.spyOn(window.location, "assign")` (which fails silently).
 */
describe("ReplicateImpersonationSessionButton — outcome branches (issue #428)", () => {
  let originalLocation: Location;
  let assignMock: ReturnType<typeof vi.fn>;
  let hrefValue: string;

  beforeEach(() => {
    sessionStorage.clear();
    originalLocation = window.location;
    assignMock = vi.fn();
    hrefValue = "";
    Object.defineProperty(window, "location", {
      writable: true,
      configurable: true,
      value: {
        ...originalLocation,
        origin: "https://app.givernance.org",
        assign: assignMock,
        get href() {
          return hrefValue;
        },
        set href(v: string) {
          hrefValue = v;
        },
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "location", {
      writable: true,
      configurable: true,
      value: originalLocation,
    });
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  function baseProps(
    overrides: Partial<React.ComponentProps<typeof ReplicateImpersonationSessionButton>> = {},
  ) {
    return {
      targetUserId: "00000000-0000-0000-0000-0000000aaaaa",
      mode: "delegation" as const,
      reason: "Reproducing the donor-receipt PDF rendering issue for ticket #5872",
      targetKeycloakId: "00000000-0000-0000-0000-0000000aa101",
      targetOrgId: "tenant-1",
      targetRole: "org_admin",
      targetFirstName: "Target",
      targetLastName: "User",
      targetEmail: "target@example.org",
      tenantName: "Test Tenant",
      tenantSlug: "test-tenant",
      ...overrides,
    };
  }

  it("happy path: 201 → POST carries the (replicated) marker, navigate to /dashboard", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        data: { sessionId: "sess-new", token: "tok", mode: "delegation" },
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const user = userEvent.setup();
    render(<ReplicateImpersonationSessionButton {...baseProps()} />);
    await user.click(screen.getByRole("button", { name: /Replicate/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      targetUserId: "00000000-0000-0000-0000-0000000aaaaa",
      mode: "delegation",
    });
    // The marker is the audit-log discriminator that lets SOC readers
    // see a chain of replicates at a glance. A regression that drops
    // the marker (e.g. someone over-trims the reason in the button)
    // ships green at the API layer because the validator accepts any
    // ≥ 20-char string — this assertion is the only place that catches
    // it.
    expect(body.reason.endsWith(" (replicated)")).toBe(true);

    await waitFor(() => expect(hrefValue).toBe("/dashboard"));
    expect(assignMock).not.toHaveBeenCalled();
  });

  it("idempotent marker: a reason that already ends with (replicated) is NOT double-marked", async () => {
    // Multi-hop replicate: the user replicates a session that was
    // itself a replicate of an earlier session. Without the idempotent
    // guard, the reason would accrete " (replicated) (replicated) ..."
    // markers and eventually overflow the 2000-char cap.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ data: { sessionId: "sess-new" } }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const user = userEvent.setup();
    render(
      <ReplicateImpersonationSessionButton
        {...baseProps({
          reason: "Original investigation reason text that ends with the marker (replicated)",
        })}
      />,
    );
    await user.click(screen.getByRole("button", { name: /Replicate/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body),
    );
    // Marker appears exactly once.
    expect(body.reason.match(/\(replicated\)/g)?.length).toBe(1);
  });

  it("401 step_up_required=true: stash payload + redirect to /api/auth/login", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({
        type: "https://httpproblems.com/http-status/401",
        title: "Unauthorized",
        status: 401,
        detail: "Step-up authentication required.",
        reason: "auth_time_stale",
        step_up_required: true,
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const user = userEvent.setup();
    render(<ReplicateImpersonationSessionButton {...baseProps()} />);
    await user.click(screen.getByRole("button", { name: /Replicate/i }));

    await waitFor(() => expect(assignMock).toHaveBeenCalledTimes(1));
    const firstCall = assignMock.mock.calls[0];
    if (!firstCall) throw new Error("expected assign() to have been called");
    const target = new URL(firstCall[0] as string);
    expect(target.origin).toBe("https://app.givernance.org");
    expect(target.pathname).toBe("/api/auth/login");
    expect(target.searchParams.get("acr_values")).toBe("2");
    expect(target.searchParams.get("return_to")).toBe("/admin/impersonation/new");

    // Stash matches what the start-form's mount-effect expects so the
    // Resume banner can pick it up after the MFA round-trip.
    const stashRaw = sessionStorage.getItem("gv-impersonation-resubmit");
    expect(stashRaw).toBeTruthy();
    const stash = JSON.parse(stashRaw as string);
    expect(stash.mode).toBe("delegation");
    expect(stash.reason.endsWith(" (replicated)")).toBe(true);
    expect(stash.target.id).toBe("00000000-0000-0000-0000-0000000aaaaa");
    expect(stash.target.keycloakId).toBe("00000000-0000-0000-0000-0000000aa101");
    expect(typeof stash.expiresAt).toBe("number");
  });

  it("401 step_up_required=false (lockout): no redirect, localised lockout error rendered", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
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
    global.fetch = fetchMock as unknown as typeof fetch;

    const user = userEvent.setup();
    render(<ReplicateImpersonationSessionButton {...baseProps()} />);
    await user.click(screen.getByRole("button", { name: /Replicate/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/temporarily locked/i));
    expect(assignMock).not.toHaveBeenCalled();
    expect(hrefValue).toBe("");
  });

  it("non-401 error response: render API's RFC 9457 detail inline", async () => {
    // 409 Conflict — the "cannot start from inside impersonation"
    // branch on the API side. Replicate should surface the API's
    // detail rather than the generic step-up copy.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        type: "https://httpproblems.com/http-status/409",
        title: "Conflict",
        status: 409,
        detail:
          "Cannot start a new impersonation session from inside another impersonation session.",
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const user = userEvent.setup();
    render(<ReplicateImpersonationSessionButton {...baseProps()} />);
    await user.click(screen.getByRole("button", { name: /Replicate/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(/Cannot start a new impersonation/i),
    );
    expect(assignMock).not.toHaveBeenCalled();
  });
});
