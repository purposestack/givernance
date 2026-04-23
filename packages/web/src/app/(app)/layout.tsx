import { cache } from "react";
import { AppShell } from "@/components/layout";
import { Toaster } from "@/components/ui/toast";
import { createServerApiClient } from "@/lib/api/client-server";
import { AuthProvider } from "@/lib/auth";
import { requireAuth } from "@/lib/auth/guards";

/**
 * Authenticated app layout — wraps all protected routes with:
 * 1. AuthProvider (client-side auth state for useAuth hook)
 * 2. AppShell (sidebar, topbar, impersonation banner, main content area)
 *
 * Impersonation info is extracted server-side from the JWT so the banner
 * renders immediately (no flash from client-side hydration delay).
 *
 * Route protection is handled by:
 * - proxy.ts (middleware): redirects unauthenticated users to /login
 * - requireAuth(): server-side auth context extraction
 *
 * FE-1 (PR #118 review): both the provisional-admin banner and the org
 * switcher depend on `/v1/users/me*` responses. `React.cache` dedupes the
 * two fetches within a single request render.
 */
const fetchMeWithMembership = cache(async () => {
  const api = await createServerApiClient();
  const [meRes, orgsRes] = await Promise.allSettled([
    api.get<{
      data: {
        firstAdmin?: boolean;
        provisionalUntil?: string | null;
        orgSlug?: string;
      };
    }>("/v1/users/me"),
    api.get<{ data: Array<{ orgId: string }> }>("/v1/users/me/organizations"),
  ]);
  return {
    me: meRes.status === "fulfilled" ? meRes.value.data : null,
    membershipCount: orgsRes.status === "fulfilled" ? orgsRes.value.data.length : undefined,
  };
});

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const auth = await requireAuth();

  const userName = auth.firstName ? `${auth.firstName} ${auth.lastName ?? ""}`.trim() : auth.email;

  const { me, membershipCount } = await fetchMeWithMembership();

  let provisionalAdmin: { provisionalUntil: string; orgSlug: string } | undefined;
  if (
    me?.firstAdmin &&
    me.provisionalUntil &&
    me.orgSlug &&
    new Date(me.provisionalUntil) > new Date()
  ) {
    provisionalAdmin = {
      provisionalUntil: me.provisionalUntil,
      orgSlug: me.orgSlug,
    };
  }

  return (
    <AuthProvider>
      <AppShell
        impersonation={auth.impersonation}
        impersonationUserName={auth.impersonation ? userName : undefined}
        provisionalAdmin={provisionalAdmin}
        membershipCount={membershipCount}
      >
        {children}
      </AppShell>
      <Toaster />
    </AuthProvider>
  );
}
