import { getCsrfHeaderName, readCsrfTokenFromDocumentCookie } from "@/lib/auth/csrf";
import { ApiClient } from "./client";

/** Methods that require CSRF protection (state-changing per ADR-011). */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Key for globalThis singleton — survives Next.js Fast Refresh in dev. */
const GLOBAL_KEY = Symbol.for("givernance.browserApiClient");

/**
 * Where to send an operator whose impersonation session has expired.
 *
 * Issue #296: this routes through `/api/auth/restore-session` (rather than
 * straight to `/admin/impersonation`) because the proxy no longer refreshes
 * tokens inline. The restore route reads the operator's `/api/auth`-scoped
 * refresh cookie, mints a fresh platform-admin access token, then redirects
 * to the impersonation session list. Going through it unconditionally (vs.
 * relying on the proxy detecting an expired impersonation token) avoids a
 * reload loop when the impersonation token is revoked while still within
 * its `exp`.
 */
const IMPERSONATION_RECOVERY_PATH = "/api/auth/restore-session?return=%2Fadmin%2Fimpersonation";

/**
 * Whether the current browser session is an impersonation session.
 * Set by the impersonation banner (the only client component that knows
 * the SSR-resolved impersonation state) via `setImpersonationActive`.
 */
let impersonationActive = false;
/** Guard against duplicate `assign` calls when concurrent requests 401. */
let recoveryRedirecting = false;

/**
 * Mark the browser session as (not) an impersonation session.
 *
 * Wired from `ImpersonationBanner` so the browser fetch wrapper can tell,
 * on a 401, whether to trigger impersonation-expiry recovery. When the
 * impersonation token reaches its TTL mid-session on a client-side page,
 * the API returns 401 and there is no full-page navigation to restore the
 * operator session — leaving the operator dead-ended. The interceptor
 * below forces a full navigation to `/api/auth/restore-session`, which
 * mints a fresh platform-admin access token from the operator's
 * still-valid Keycloak refresh token and lands them back on the session
 * list (issue #296).
 */
export function setImpersonationActive(active: boolean): void {
  impersonationActive = active;
}

export function createBrowserFetch(fetchImpl: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    const method = (init?.method ?? "GET").toUpperCase();

    // Only attach CSRF token on state-changing requests (POST, PUT, PATCH, DELETE)
    if (MUTATING_METHODS.has(method)) {
      const csrfToken = readCsrfTokenFromDocumentCookie();
      if (csrfToken) {
        headers.set(getCsrfHeaderName(), csrfToken);
      }
    }

    // Multipart safety net (Epic #286): when a caller hands us a FormData
    // body directly (i.e. bypassing ApiClient.request), the browser only
    // emits the correct `multipart/form-data; boundary=…` header if no
    // explicit `Content-Type` is set. ApiClient.request handles this for
    // its own callers, but stripping it here too keeps direct-fetch users
    // safe.
    if (typeof FormData !== "undefined" && init?.body instanceof FormData) {
      headers.delete("Content-Type");
    }

    const response = await fetchImpl(input, {
      ...init,
      headers,
      credentials: "include",
    });

    // Impersonation-expiry recovery: a 401 on a client-side fetch while the
    // operator is impersonating means the short-lived impersonation token
    // has expired. A full-page navigation to `/api/auth/restore-session`
    // refreshes the operator's platform-admin session from their still-valid
    // Keycloak refresh token and lands them back on the session list. We
    // still return the response so the caller's normal error handling runs.
    if (
      response.status === 401 &&
      impersonationActive &&
      !recoveryRedirecting &&
      typeof window !== "undefined"
    ) {
      recoveryRedirecting = true;
      window.location.assign(IMPERSONATION_RECOVERY_PATH);
    }

    return response;
  };
}

/**
 * Create an ApiClient for use in Client Components (browser-side).
 *
 * - Uses `credentials: 'include'` so the browser sends httpOnly cookies
 * - Uses the public API URL (external, goes through the reverse proxy)
 * - CSRF token read fresh from meta tag on every mutating request (ADR-011)
 * - Singleton via globalThis — survives Fast Refresh without stale closures
 */
export function createClientApiClient(): ApiClient {
  const cached = (globalThis as Record<symbol, unknown>)[GLOBAL_KEY] as ApiClient | undefined;
  if (cached) return cached;

  const client = new ApiClient({
    baseUrl: process.env.NEXT_PUBLIC_API_URL ?? "/api",
    fetchFn: createBrowserFetch(),
  });

  (globalThis as Record<symbol, unknown>)[GLOBAL_KEY] = client;
  return client;
}
