/**
 * AuthProvider silent-refresh tests (issue #76 / PR-3).
 *
 * Covers the observable behaviours of the refresh loop:
 *   - No timer scheduled before the user hydrates
 *   - Successful refresh re-schedules using server-returned expiresIn
 *   - Successful refresh without expiresIn falls back to the default cadence
 *   - Failed refresh (4xx from /api/auth/refresh) clears local user state
 *   - Network error retries with a budget; past the budget, clears state
 *   - Provider unmount cancels the in-flight timer
 *
 * The component imports `next-intl` indirectly through the CSRF + log
 * modules, so the global setup mocks are enough — no extra mocks needed
 * here beyond global fetch.
 */

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/tests/test-utils";
import { AuthProvider, useAuth } from "./auth-context";

function HydratedUserBadge() {
  const { user, loading, error, hasRole, hasAppRole } = useAuth();
  return (
    <div>
      <span data-testid="loading">{loading ? "1" : "0"}</span>
      <span data-testid="error">{error ?? ""}</span>
      <span data-testid="user">{user?.email ?? ""}</span>
      <span data-testid="user-id">{user?.id ?? ""}</span>
      <span data-testid="is-org-admin">{hasAppRole("org_admin") ? "1" : "0"}</span>
      <span data-testid="is-super-admin">{hasRole("super_admin") ? "1" : "0"}</span>
    </div>
  );
}

function Wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

// The REAL `GET /v1/users/me` payload (`MeResponse` in
// packages/api/src/modules/users/routes.ts). Issue #613: the previous
// fixture invented `userId` + `roles`, which is the only reason the
// refresh-loop tests passed while the loop never ran in production.
const ME_RESPONSE = {
  data: {
    id: "0190a1b2-0000-7000-8000-000000000001",
    orgId: "0190a1b2-0000-7000-8000-0000000000aa",
    keycloakId: "kc-user-1",
    email: "claire@solidarite-med.org",
    firstName: "Claire",
    lastName: "Dubois",
    role: "org_admin",
    firstAdmin: true,
    provisionalUntil: null,
    locale: null,
    tenantDefaultLocale: "fr",
    orgSlug: "solidarite-med",
    orgName: "Solidarité Méditerranée",
    createdAt: "2026-01-05T09:00:00.000Z",
    updatedAt: "2026-01-05T09:00:00.000Z",
  },
};

function mockFetchImpl(
  meHandler: () => Response,
  refreshHandler: () => Response | Promise<Response>,
) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/v1/users/me")) return meHandler();
    if (url.endsWith("/api/auth/refresh")) return await refreshHandler();
    throw new Error(`unexpected fetch URL: ${url}`);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("AuthProvider silent refresh", () => {
  it("schedules a refresh ~240s after hydration and re-schedules from server expiresIn", async () => {
    const refreshHandler = vi.fn(
      () =>
        new Response(JSON.stringify({ ok: true, expiresIn: 300 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal(
      "fetch",
      mockFetchImpl(
        () =>
          new Response(JSON.stringify(ME_RESPONSE), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        refreshHandler,
      ),
    );

    render(
      <Wrapper>
        <HydratedUserBadge />
      </Wrapper>,
    );

    // Wait for /v1/users/me to resolve (microtask + state update).
    await waitFor(() => {
      expect(screen.getByTestId("user").textContent).toBe("claire@solidarite-med.org");
    });

    // Before 240s, no refresh yet.
    await vi.advanceTimersByTimeAsync(230 * 1000);
    expect(refreshHandler).not.toHaveBeenCalled();

    // After 240s, refresh fires.
    await vi.advanceTimersByTimeAsync(15 * 1000);
    expect(refreshHandler).toHaveBeenCalledOnce();

    // Server said expiresIn=300, so next schedule = 300_000 - 60_000 = 240_000ms.
    // Before that window: no second refresh.
    await vi.advanceTimersByTimeAsync(230 * 1000);
    expect(refreshHandler).toHaveBeenCalledOnce();

    // After 240_000ms from the prior refresh, second one fires.
    await vi.advanceTimersByTimeAsync(15 * 1000);
    expect(refreshHandler).toHaveBeenCalledTimes(2);
  });

  it("clears local user state on a 401 from /api/auth/refresh (session_expired)", async () => {
    const refreshHandler = vi.fn(
      () => new Response(JSON.stringify({ error: "refresh_rejected" }), { status: 401 }),
    );
    vi.stubGlobal(
      "fetch",
      mockFetchImpl(
        () =>
          new Response(JSON.stringify(ME_RESPONSE), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        refreshHandler,
      ),
    );

    render(
      <Wrapper>
        <HydratedUserBadge />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("user").textContent).toBe("claire@solidarite-med.org");
    });

    await vi.advanceTimersByTimeAsync(245 * 1000);

    await waitFor(() => {
      expect(screen.getByTestId("user").textContent).toBe("");
    });
    expect(screen.getByTestId("error").textContent).toBe("session_expired");
  });

  it("retries network errors up to MAX_REFRESH_RETRIES before clearing state", async () => {
    const refreshHandler = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal(
      "fetch",
      mockFetchImpl(
        () =>
          new Response(JSON.stringify(ME_RESPONSE), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        refreshHandler,
      ),
    );

    render(
      <Wrapper>
        <HydratedUserBadge />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("user").textContent).toBe("claire@solidarite-med.org");
    });

    // First refresh at 240s — fails.
    await vi.advanceTimersByTimeAsync(245 * 1000);
    expect(refreshHandler).toHaveBeenCalledTimes(1);
    // User still hydrated; we're inside the retry budget.
    expect(screen.getByTestId("user").textContent).toBe("claire@solidarite-med.org");

    // Four more retries at 30s each = 120s total. After the 5th failure
    // (1 initial + 4 retries), retryCount hits MAX_REFRESH_RETRIES = 5
    // and the loop clears state.
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(31 * 1000);
    }

    await waitFor(() => {
      expect(screen.getByTestId("user").textContent).toBe("");
    });
    expect(screen.getByTestId("error").textContent).toBe("refresh_unreachable");
  });

  it("schedules the refresh timer once the real /me shape hydrates (issue #613)", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    vi.stubGlobal(
      "fetch",
      mockFetchImpl(
        () => new Response(JSON.stringify(ME_RESPONSE), { status: 200 }),
        () => new Response(JSON.stringify({ ok: true, expiresIn: 300 }), { status: 200 }),
      ),
    );

    render(
      <Wrapper>
        <HydratedUserBadge />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("user-id").textContent).toBe(ME_RESPONSE.data.id);
    });

    // The loop is keyed on `user.id`; its first timer is the 240s cadence.
    expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === 240 * 1000)).toBe(true);
    // Roles derive from the single `role` field — no `roles[]` on the wire.
    expect(screen.getByTestId("is-org-admin").textContent).toBe("1");
    expect(screen.getByTestId("is-super-admin").textContent).toBe("0");
    setTimeoutSpy.mockRestore();
  });

  it("treats a /me payload without an id as a failed hydration (no refresh loop)", async () => {
    const refreshHandler = vi.fn(() => new Response("{}", { status: 200 }));
    vi.stubGlobal(
      "fetch",
      mockFetchImpl(
        () =>
          new Response(JSON.stringify({ data: { userId: "legacy", email: "x@y.z", roles: [] } }), {
            status: 200,
          }),
        refreshHandler,
      ),
    );

    render(
      <Wrapper>
        <HydratedUserBadge />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("error").textContent).toContain("Malformed user profile");
    });
    await vi.advanceTimersByTimeAsync(245 * 1000);
    expect(refreshHandler).not.toHaveBeenCalled();
  });

  it("keeps the user hydrated and the loop alive on the impersonation no-op response", async () => {
    const refreshHandler = vi.fn(
      () =>
        new Response(JSON.stringify({ ok: true, skipped: "impersonation", expiresIn: null }), {
          status: 200,
        }),
    );
    vi.stubGlobal(
      "fetch",
      mockFetchImpl(
        () => new Response(JSON.stringify(ME_RESPONSE), { status: 200 }),
        refreshHandler,
      ),
    );

    render(
      <Wrapper>
        <HydratedUserBadge />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("user").textContent).toBe("claire@solidarite-med.org");
    });

    await vi.advanceTimersByTimeAsync(245 * 1000);
    expect(refreshHandler).toHaveBeenCalledOnce();
    expect(screen.getByTestId("user").textContent).toBe("claire@solidarite-med.org");
    expect(screen.getByTestId("error").textContent).toBe("");

    // No expiresIn → default cadence; the next tick still fires.
    await vi.advanceTimersByTimeAsync(245 * 1000);
    expect(refreshHandler).toHaveBeenCalledTimes(2);
  });

  it("retries a 503 from the refresh route instead of clearing the session", async () => {
    const refreshHandler = vi.fn(
      () => new Response(JSON.stringify({ error: "network_failure" }), { status: 503 }),
    );
    vi.stubGlobal(
      "fetch",
      mockFetchImpl(
        () => new Response(JSON.stringify(ME_RESPONSE), { status: 200 }),
        refreshHandler,
      ),
    );

    render(
      <Wrapper>
        <HydratedUserBadge />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("user").textContent).toBe("claire@solidarite-med.org");
    });

    await vi.advanceTimersByTimeAsync(245 * 1000);
    expect(refreshHandler).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("user").textContent).toBe("claire@solidarite-med.org");

    // Retried on the 30s backoff, not the 240s cadence.
    await vi.advanceTimersByTimeAsync(31 * 1000);
    expect(refreshHandler).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("error").textContent).toBe("");
  });
});
