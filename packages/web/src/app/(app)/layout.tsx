import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout";
import { AuthProvider } from "@/lib/auth";
import { requireAuth } from "@/lib/auth/guards";
import { getTenantMe } from "@/services/tenant-service";

/**
 * Authenticated app layout — wraps all protected routes with:
 * 1. AuthProvider (client-side auth state for useAuth hook)
 * 2. AppShell (sidebar, topbar, impersonation banner, main content area)
 *
 * Also enforces the onboarding gate (#40 PR-A4): users whose tenant has not
 * completed onboarding are routed to /onboarding. This runs on every (app)
 * route render — cheap because the API hop is server-side and only issues a
 * small JSON response.
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

  const tenant = await getTenantMe();
  if (!tenant?.onboardingCompletedAt) {
    redirect("/onboarding");
  }

  const userName = auth.firstName ? `${auth.firstName} ${auth.lastName ?? ""}`.trim() : auth.email;

  return (
    <AuthProvider>
      <AppShell
        impersonation={auth.impersonation}
        impersonationUserName={auth.impersonation ? userName : undefined}
      >
        {children}
      </AppShell>
    </AuthProvider>
  );
}
