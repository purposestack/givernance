import { ApiClient } from "./client";

/**
 * Read the CSRF token from the meta tag. Called per-request so that
 * rotated tokens (after session refresh) are picked up immediately.
 */
function getCsrfToken(): string | undefined {
  if (typeof document === "undefined") return undefined;
  return document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content;
}

/** Methods that require CSRF protection (state-changing per ADR-011). */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Key for globalThis singleton — survives Next.js Fast Refresh in dev. */
const GLOBAL_KEY = Symbol.for("givernance.browserApiClient");

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
    fetchFn: (input, init) => {
      const headers = new Headers(init?.headers);
      const method = (init?.method ?? "GET").toUpperCase();

      // Only attach CSRF token on state-changing requests (POST, PUT, PATCH, DELETE)
      if (MUTATING_METHODS.has(method)) {
        const csrfToken = getCsrfToken();
        if (csrfToken) {
          headers.set("X-CSRF-Token", csrfToken);
        }
      }

      return fetch(input, {
        ...init,
        headers,
        credentials: "include",
      });
    },
  });

  (globalThis as Record<symbol, unknown>)[GLOBAL_KEY] = client;
  return client;
}
