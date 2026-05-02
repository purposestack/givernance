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
  const isSuperAdmin = auth.roles.includes("super_admin");

  const userName = auth.firstName ? `${auth.firstName} ${auth.lastName ?? ""}`.trim() : auth.email;

  const { me, membershipCount } = await fetchMeWithMembership();

  // Broken state: a non-super-admin reached the authenticated layout but
  // we couldn't resolve their tenant memberships. Two failure modes:
  //   - `membershipCount === undefined`: `/v1/users/me/organizations`
  //     rejected (transient 5xx, network blip).
  //   - `membershipCount === 0`: the user has no active memberships —
  //     usually a JWT that outlived a tenant-removal, which the auth
  //     plugin's active-row check (ADR-021) is supposed to catch
  //     upstream; landing here means the check was bypassed somehow.
  //
  // Either way the user has nothing to do in the app — silently
  // rendering a half-broken sidebar / data-less dashboard would mask
  // a real bug. Throwing surfaces it in logs + Next.js's error boundary
  // so we can investigate. Super-admins are exempt: they legitimately
  // have zero tenant memberships by design (ADR-022).
  if (!isSuperAdmin && (membershipCount === undefined || membershipCount === 0)) {
    throw new Error(
      `Authenticated tenant user has no resolvable memberships (membershipCount=${membershipCount}). ` +
        `Check /v1/users/me/organizations and the auth plugin's active-row guard.`,
    );
  }

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
        isSuperAdmin={auth.roles.includes("super_admin")}
      >
        {children}
      </AppShell>
      <Toaster />
    </AuthProvider>
  );
}
