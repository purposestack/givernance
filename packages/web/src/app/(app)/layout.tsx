import { AppShell } from "@/components/layout";
import { Toaster } from "@/components/ui/toast";
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

  return (
    <AuthProvider>
      <AppShell
        impersonation={auth.impersonation}
        impersonationUserName={auth.impersonation ? userName : undefined}
      >
        {children}
      </AppShell>
      <Toaster />
    </AuthProvider>
  );
}
