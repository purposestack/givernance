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
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const auth = await requireAuth();

  const userName = auth.firstName ? `${auth.firstName} ${auth.lastName ?? ""}`.trim() : auth.email;

  // Best-effort fetch of the provisional-admin window. Any failure hides the
  // banner — it's not a blocker for rendering the app shell.
  let provisionalAdmin: { provisionalUntil: string; orgSlug: string } | undefined;
  try {
    const api = await createServerApiClient();
    const res = await api.get<{
      data: {
        firstAdmin?: boolean;
        provisionalUntil?: string | null;
        orgSlug?: string;
      };
    }>("/v1/users/me");
    if (
      res.data.firstAdmin &&
      res.data.provisionalUntil &&
      res.data.orgSlug &&
      new Date(res.data.provisionalUntil) > new Date()
    ) {
      provisionalAdmin = {
        provisionalUntil: res.data.provisionalUntil,
        orgSlug: res.data.orgSlug,
      };
    }
  } catch {
    // Banner is optional — swallow errors silently.
  }

  return (
    <AuthProvider>
      <AppShell
        impersonation={auth.impersonation}
        impersonationUserName={auth.impersonation ? userName : undefined}
        provisionalAdmin={provisionalAdmin}
      >
        {children}
      </AppShell>
      <Toaster />
    </AuthProvider>
  );
}
