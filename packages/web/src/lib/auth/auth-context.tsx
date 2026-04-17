"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

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
  /** Sign out — clears cookie via API route and redirects. */
  logout: () => void;
  /** Re-fetch the user profile. */
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

async function fetchMe(): Promise<UserProfile> {
  const res = await fetch(`${API_URL}/v1/users/me`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch user profile: ${res.status}`);
  }
  return res.json() as Promise<UserProfile>;
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

  const hasRole = useCallback(
    (role: string) => state.user?.roles.includes(role) ?? false,
    [state.user],
  );

  const hasAppRole = useCallback(
    (role: "org_admin" | "user" | "viewer") => state.user?.role === role,
    [state.user],
  );

  const logout = useCallback(() => {
    window.location.href = "/api/auth/logout";
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      hasRole,
      hasAppRole,
      isImpersonating: !!state.user?.act,
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
