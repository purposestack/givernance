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

/** Application role as stored on `users.role`; platform admins get `super_admin`. */
export type UserRole = "org_admin" | "user" | "viewer" | "super_admin";

/**
 * User profile shape as returned by GET /v1/users/me (`MeResponse` in
 * packages/api/src/modules/users/routes.ts). The endpoint answers from the
 * TARGET's perspective during an impersonation session and carries no
 * impersonation claims — that state is SSR-resolved from the JWT (see
 * `requireAuth` in guards.ts) and threaded to `ImpersonationBanner` as props.
 */
export interface UserProfile {
  /** `users.id` (or `platform_admins.id` for a super-admin). */
  id: string;
  orgId: string;
  keycloakId: string | null;
  email: string;
  firstName: string;
  lastName: string;
  /** Undefined when the API returns a role this client doesn't know. */
  role: UserRole | undefined;
  firstAdmin: boolean;
  provisionalUntil: string | null;
  locale: string | null;
  tenantDefaultLocale: string;
  orgSlug: string;
  /** Organisation name for display. */
  orgName: string;
  createdAt: string;
  updatedAt: string;
}

interface AuthState {
  user: UserProfile | null;
  loading: boolean;
  error: string | null;
}

interface AuthContextValue extends AuthState {
  /**
   * Check the current user's role. `/v1/users/me` exposes a single `role`
   * (no realm-role list), so this compares against it — `"super_admin"`
   * matches platform admins.
   */
  hasRole: (role: string) => boolean;
  /** Check if the current user has a specific application role. */
  hasAppRole: (role: "org_admin" | "user" | "viewer") => boolean;
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
/** Backoff after a transient network failure. */
const REFRESH_RETRY_DELAY_MS = 30 * 1000;
/**
 * Max consecutive transient failures before treating the session as gone
 * (PR #360 review Frontend M4). At 30s per retry, 5 ≈ 2.5 min — well past
 * the access-token TTL, so any token the user still has is already dead
 * and we should let them re-auth rather than keep hammering Keycloak.
 */
const MAX_REFRESH_RETRIES = 5;

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
  const body = (await res.json()) as { data?: Record<string, unknown> | null };
  return toUserProfile(body.data);
}

const USER_ROLES: readonly string[] = ["org_admin", "user", "viewer", "super_admin"];

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function strOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Map the `/v1/users/me` payload field by field instead of casting it.
 * Issue #613: a blind cast let the client type drift from `MeResponse`
 * (`userId` / `roles` never existed on the wire), which silently disabled
 * the refresh loop below. A payload without a usable `id` is a contract
 * break — fail the hydration rather than run with a half-typed user.
 */
function toUserProfile(data: Record<string, unknown> | null | undefined): UserProfile {
  if (!data || typeof data.id !== "string" || data.id.length === 0) {
    throw new Error("Malformed user profile: missing id");
  }
  return {
    id: data.id,
    orgId: str(data.orgId),
    keycloakId: strOrNull(data.keycloakId),
    email: str(data.email),
    firstName: str(data.firstName),
    lastName: str(data.lastName),
    role:
      typeof data.role === "string" && USER_ROLES.includes(data.role)
        ? (data.role as UserRole)
        : undefined,
    firstAdmin: data.firstAdmin === true,
    provisionalUntil: strOrNull(data.provisionalUntil),
    locale: strOrNull(data.locale),
    tenantDefaultLocale: str(data.tenantDefaultLocale),
    orgSlug: str(data.orgSlug),
    orgName: str(data.orgName),
    createdAt: str(data.createdAt),
    updatedAt: str(data.updatedAt),
  };
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
  //
  // Depends on `state.user?.id` (stable string), not the full user
  // object, so a re-fetch of /v1/users/me that returns content-equal
  // data doesn't cancel-and-re-schedule the timer mid-cycle
  // (PR #360 review Frontend M5).
  const userId = state.user?.id;
  useEffect(() => {
    if (!userId) return;

    const ctx: RefreshLoopContext = {
      cancelled: false,
      retryCount: 0,
      lastSuccessAt: Date.now(),
      timerRef: refreshTimerRef,
      setState,
    };

    const scheduleNext = (delayMs: number) => {
      if (ctx.cancelled) return;
      if (ctx.timerRef.current) clearTimeout(ctx.timerRef.current);
      ctx.timerRef.current = setTimeout(
        () => {
          void runRefreshIteration(ctx, scheduleNext);
        },
        Math.max(delayMs, 1000),
      );
    };

    scheduleNext(DEFAULT_REFRESH_INTERVAL_MS);

    // PR #360 review (Frontend M3): browsers throttle setTimeout in
    // background tabs (Chrome's intensive throttling kicks in after
    // ~5 min of inactivity). A user who backgrounds the tab for an hour
    // would otherwise have the 4-min timer fire well past token expiry,
    // landing them at /login on their next foreground action. On every
    // tab-focus, if we're past-due for a refresh, fire one immediately.
    const onVisibilityChange = () => {
      if (ctx.cancelled || document.visibilityState !== "visible") return;
      const elapsed = Date.now() - ctx.lastSuccessAt;
      if (elapsed >= DEFAULT_REFRESH_INTERVAL_MS - REFRESH_GRACE_MS) {
        scheduleNext(0);
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      ctx.cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (ctx.timerRef.current) {
        clearTimeout(ctx.timerRef.current);
        ctx.timerRef.current = null;
      }
    };
  }, [userId]);

  const hasRole = useCallback((role: string) => state.user?.role === role, [state.user]);

  const hasAppRole = useCallback(
    (role: "org_admin" | "user" | "viewer") => state.user?.role === role,
    [state.user],
  );

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
      logout,
      refresh: loadUser,
    }),
    [state, hasRole, hasAppRole, logout, loadUser],
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

// ─── Silent-refresh helpers (issue #76 / PR-3) ─────────────────────────────
//
// Extracted from the AuthProvider effect to keep its cognitive complexity
// below the Biome ceiling — the effect now just owns the lifecycle
// (scheduling, visibility, cleanup) while these functions own the
// fetch + response → next-action mapping.

interface RefreshLoopContext {
  cancelled: boolean;
  retryCount: number;
  lastSuccessAt: number;
  timerRef: { current: ReturnType<typeof setTimeout> | null };
  setState: (state: AuthState) => void;
}

async function runRefreshIteration(
  ctx: RefreshLoopContext,
  scheduleNext: (delayMs: number) => void,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch("/api/auth/refresh", {
      method: "POST",
      credentials: "include",
      // No CSRF header — the refresh route does not gate on it.
      // See `/api/auth/refresh/route.ts` for the rationale.
    });
  } catch {
    handleRefreshNetworkError(ctx, scheduleNext);
    return;
  }

  if (res.status >= 500) {
    // The refresh route answers 503 (cookies kept) when Keycloak is
    // unreachable — same retry budget as a browser-side network error,
    // not a session loss.
    handleRefreshNetworkError(ctx, scheduleNext);
    return;
  }

  if (!res.ok) {
    // Refresh refused (refresh-token revoked / session ended via
    // back-channel logout / admin sign-out-all). Mark the local
    // session as gone — middleware sends the next nav to /login.
    if (!ctx.cancelled) {
      ctx.setState({ user: null, loading: false, error: "session_expired" });
    }
    return;
  }

  // A 200 also covers the impersonation no-op (`skipped: "impersonation"`,
  // `expiresIn: null`): the route left the cookies alone, the user stays
  // hydrated, and the loop keeps ticking at the default cadence so rotation
  // resumes on its own once the operator's session is back.
  ctx.retryCount = 0;
  ctx.lastSuccessAt = Date.now();
  const expiresInMs = await readExpiresInMs(res);
  scheduleNext(expiresInMs - REFRESH_GRACE_MS);
}

function handleRefreshNetworkError(
  ctx: RefreshLoopContext,
  scheduleNext: (delayMs: number) => void,
): void {
  ctx.retryCount += 1;
  if (ctx.retryCount >= MAX_REFRESH_RETRIES) {
    // Keycloak / network sustained-down past the access-token TTL —
    // any token we still have is already dead, so stop hammering and
    // let the user re-auth on the next protected navigation.
    if (!ctx.cancelled) {
      ctx.setState({ user: null, loading: false, error: "refresh_unreachable" });
    }
    return;
  }
  // Transient network failure — retry sooner than the default cadence
  // so a brief blip doesn't leak into a forced logout when the token
  // would otherwise still be valid.
  scheduleNext(REFRESH_RETRY_DELAY_MS);
}

async function readExpiresInMs(res: Response): Promise<number> {
  const body = (await res.json().catch(() => null)) as { expiresIn?: number } | null;
  if (typeof body?.expiresIn === "number" && body.expiresIn > 0) {
    return body.expiresIn * 1000;
  }
  return DEFAULT_REFRESH_INTERVAL_MS + REFRESH_GRACE_MS;
}
