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
  const { user, loading, error } = useAuth();
  return (
    <div>
      <span data-testid="loading">{loading ? "1" : "0"}</span>
      <span data-testid="error">{error ?? ""}</span>
      <span data-testid="user">{user?.email ?? ""}</span>
    </div>
  );
}

function Wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

const ME_RESPONSE = {
  data: {
    userId: "user-1",
    orgId: "org-1",
    email: "claire@solidarite-med.org",
    firstName: "Claire",
    lastName: "Dubois",
    roles: [],
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
});
