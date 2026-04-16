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

/** User profile as returned by GET /v1/users/me */
interface UserProfile {
  userId: string;
  orgId: string;
  email: string;
  firstName?: string;
  lastName?: string;
  roles: string[];
  role?: "org_admin" | "user" | "viewer";
  /** RFC 8693 actor claim — present when an admin is impersonating this user */
  act?: { sub: string };
}

interface AuthState {
  user: UserProfile | null;
  loading: boolean;
  error: string | null;
}

interface AuthContextValue extends AuthState {
  /** Check if the current user has a specific Keycloak realm role */
  hasRole: (role: string) => boolean;
  /** Check if the current user has a specific application role */
  hasAppRole: (role: "org_admin" | "user" | "viewer") => boolean;
  /** Whether the current session is an impersonation session */
  isImpersonating: boolean;
  /** Sign out — clears cookie via API route and redirects */
  logout: () => void;
  /** Re-fetch the user profile */
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const API_URL = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3001";

async function fetchMe(): Promise<UserProfile> {
  const res = await fetch(`${API_URL}/v1/users/me`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch user profile: ${res.status}`);
  }
  const body = (await res.json()) as { data: UserProfile };
  return body.data;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    loading: true,
    error: null,
  });

  const loadUser = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const user = await fetchMe();
      setState({ user, loading: false, error: null });
    } catch (err) {
      setState({
        user: null,
        loading: false,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }, []);

  useEffect(() => {
    void loadUser();
  }, [loadUser]);

  const hasRole = useCallback(
    (role: string) => state.user?.roles.includes(role) ?? false,
    [state.user],
  );

  const hasAppRole = useCallback(
    (role: "org_admin" | "user" | "viewer") => state.user?.role === role,
    [state.user],
  );

  const isImpersonating = !!state.user?.act;

  const logout = useCallback(() => {
    window.location.href = "/api/auth/logout";
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      hasRole,
      hasAppRole,
      isImpersonating,
      logout,
      refresh: loadUser,
    }),
    [state, hasRole, hasAppRole, isImpersonating, logout, loadUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an <AuthProvider>");
  }
  return ctx;
}

/** Utility: require a specific role, returns null for children if not authorized */
export function RequireRole({
  role,
  children,
  fallback = null,
}: {
  role: string;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { hasRole, loading } = useAuth();
  if (loading) return null;
  return hasRole(role) ? children : fallback;
}

/** Utility: require a specific app-level permission */
export function RequireAppRole({
  role,
  children,
  fallback = null,
}: {
  role: "org_admin" | "user" | "viewer";
  children: ReactNode;
  fallback?: ReactNode;
}) {
  const { hasAppRole, loading } = useAuth();
  if (loading) return null;
  return hasAppRole(role) ? children : fallback;
}
