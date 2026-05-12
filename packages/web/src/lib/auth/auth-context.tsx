"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getCsrfHeaderName, readCsrfTokenFromDocumentCookie } from "@/lib/auth/csrf";

/** User profile shape as returned by GET /v1/users/me. */
export interface UserProfile {
  userId: string;
  orgId: string;
  email: string;
  firstName?: string;
  lastName?: string;
  roles: string[];
  /** Application role — derived from Keycloak realm roles. */
  role?: "org_admin" | "user" | "viewer";
  /** RFC 8693 actor claim — present when an admin is impersonating this user. */
  act?: { sub: string };
  /** Organisation name for display (from GET /v1/users/me response). */
  orgName?: string;
  /** Impersonation session ID — for ending the session via DELETE. */
  impSessionId?: string;
  /** Mandatory reason for impersonation (e.g. "Support ticket #1234"). */
  impReason?: string;
}

interface AuthState {
  user: UserProfile | null;
  loading: boolean;
  error: string | null;
}

interface AuthContextValue extends AuthState {
  /** Check if the current user has a specific Keycloak realm role. */
  hasRole: (role: string) => boolean;
  /** Check if the current user has a specific application role. */
  hasAppRole: (role: "org_admin" | "user" | "viewer") => boolean;
  /** Whether the current session is an impersonation session. */
  isImpersonating: boolean;
  /** End impersonation session — calls DELETE /admin/impersonation/:sessionId. */
  endImpersonation: () => void;
  /** Sign out — clears cookie via API route and redirects. */
  logout: () => void;
  /** Re-fetch the user profile. */
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

/**
 * Silent-refresh cadence (issue #76 / PR-3). The realm sets
 * `access.token.lifespan=300` (5 minutes), so we rotate the token at
 * ~4 minutes (240s) — gives 60s of headroom for a Keycloak blip or a
 * slow refresh round-trip without the user noticing. Server response
 * carries `expiresIn` so we self-correct if the realm policy changes.
 */
const DEFAULT_REFRESH_INTERVAL_MS = 240 * 1000;
const REFRESH_GRACE_MS = 60 * 1000;

async function fetchMe(): Promise<UserProfile> {
  const res = await fetch(`${API_URL}/v1/users/me`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch user profile: ${res.status}`);
  }
  // The API wraps every response in `{ data: ... }` (see DataResponse schema
  // in packages/api/src/lib/schemas.ts). Without unwrapping `.data` here,
  // every field on `UserProfile` lands as undefined — including `orgName`,
  // which the sidebar reads to display the active org. The server-side
  // fetcher in `(app)/layout.tsx` already handles this correctly; this
  // brings the client-side fetcher into line.
  const body = (await res.json()) as { data: Record<string, unknown> };
  return body.data as unknown as UserProfile;
}

/**
 * AuthProvider — wraps the app (or protected subtrees) with auth state.
 *
 * On mount, fetches /v1/users/me to hydrate user profile. If the fetch fails
 * (401, network error), the user is treated as unauthenticated and the
 * middleware will redirect to /login on the next navigation.
 *
 * Exposes:
 * - `user`, `loading`, `error` — auth state
 * - `hasRole()`, `hasAppRole()` — permission checks
 * - `isImpersonating` — true when JWT contains RFC 8693 `act` claim
 * - `logout()` — calls /api/auth/logout
 * - `refresh()` — re-fetches user profile
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    loading: true,
    error: null,
  });
  // Holds the next scheduled silent-refresh timer so we can cancel/replace
  // it (e.g. when a refresh succeeds and returns a new `expires_in`, or
  // when the provider unmounts during navigation).
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadUser = useCallback(async () => {
    try {
      setState((prev) => ({ ...prev, loading: true, error: null }));
      const user = await fetchMe();
      setState({ user, loading: false, error: null });
    } catch (err) {
      setState({
        user: null,
        loading: false,
        error: err instanceof Error ? err.message : "Failed to load user",
      });
    }
  }, []);

  useEffect(() => {
    loadUser();
  }, [loadUser]);

  // Silent access-token refresh (issue #76 / PR-3). Rotates the access
  // token before it expires so the user doesn't get bounced to /login
  // every 5 minutes. On refresh failure, clear local auth state so the
  // next protected navigation falls through to the middleware redirect.
  useEffect(() => {
    // Only schedule once we have a hydrated user — refreshing before
    // we even know who the user is would race the first /v1/users/me.
    if (!state.user) return;

    let cancelled = false;

    const scheduleNext = (delayMs: number) => {
      if (cancelled) return;
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = setTimeout(runRefresh, Math.max(delayMs, 1000));
    };

    const runRefresh = async () => {
      try {
        const res = await fetch("/api/auth/refresh", {
          method: "POST",
          credentials: "include",
          // No CSRF header — the refresh route does not gate on it.
          // See `/api/auth/refresh/route.ts` for the rationale.
        });
        if (!res.ok) {
          // Refresh refused (refresh-token revoked / session ended via
          // back-channel logout / admin sign-out-all). Mark the local
          // session as gone — middleware sends the next nav to /login.
          if (!cancelled) {
            setState({ user: null, loading: false, error: "session_expired" });
          }
          return;
        }
        const body = (await res.json().catch(() => null)) as { expiresIn?: number } | null;
        const expiresInMs =
          typeof body?.expiresIn === "number" && body.expiresIn > 0
            ? body.expiresIn * 1000
            : DEFAULT_REFRESH_INTERVAL_MS + REFRESH_GRACE_MS;
        scheduleNext(expiresInMs - REFRESH_GRACE_MS);
      } catch {
        // Transient network failure — retry sooner than the default
        // cadence (30s) so a brief blip doesn't leak into a forced
        // logout when the token would otherwise still be valid.
        scheduleNext(30 * 1000);
      }
    };

    scheduleNext(DEFAULT_REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [state.user]);

  const hasRole = useCallback(
    (role: string) => state.user?.roles.includes(role) ?? false,
    [state.user],
  );

  const hasAppRole = useCallback(
    (role: "org_admin" | "user" | "viewer") => state.user?.role === role,
    [state.user],
  );

  /** Read CSRF token from the double-submit cookie on demand. */
  const getCsrfToken = useCallback((): string | undefined => {
    return readCsrfTokenFromDocumentCookie();
  }, []);

  const endImpersonation = useCallback(() => {
    const sessionId = state.user?.impSessionId;
    if (!sessionId) return;

    const csrfToken = getCsrfToken();
    // DELETE per doc/19-impersonation.md § 4 — ends the session, revokes token
    fetch(`${API_URL}/admin/impersonation/${sessionId}`, {
      method: "DELETE",
      credentials: "include",
      headers: csrfToken ? { [getCsrfHeaderName()]: csrfToken } : {},
    }).then(() => {
      // Redirect to admin dashboard after ending impersonation
      window.location.href = "/dashboard";
    });
  }, [state.user?.impSessionId, getCsrfToken]);

  const logout = useCallback(() => {
    // Submit a form POST rather than fetch() so the browser can natively
    // follow the cross-origin redirect to Keycloak's end-session endpoint.
    // fetch() rejects here with "Failed to fetch" because the redirect
    // target (localhost:8080) doesn't return CORS headers for an XHR.
    const form = document.createElement("form");
    form.method = "POST";
    form.action = "/api/auth/logout";
    document.body.appendChild(form);
    form.submit();
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      hasRole,
      hasAppRole,
      isImpersonating: !!state.user?.act,
      endImpersonation,
      logout,
      refresh: loadUser,
    }),
    [state, hasRole, hasAppRole, endImpersonation, logout, loadUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/**
 * Hook to access auth state in Client Components.
 * Must be used within an <AuthProvider>.
 */
export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an <AuthProvider>");
  }
  return context;
}
