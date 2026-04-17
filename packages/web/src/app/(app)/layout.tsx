import { AppShell } from "@/components/layout";
import { AuthProvider } from "@/lib/auth";

/**
 * Authenticated app layout — wraps all protected routes with:
 * 1. AuthProvider (client-side auth state for useAuth hook)
 * 2. AppShell (sidebar, topbar, impersonation banner, main content area)
 *
 * Route protection is handled by:
 * - proxy.ts (middleware): redirects unauthenticated users to /login
 * - Individual pages: can call requireAuth() for server-side auth context
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <AppShell>{children}</AppShell>
    </AuthProvider>
  );
}
