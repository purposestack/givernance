import { notFound } from "next/navigation";
import { AppShell } from "@/components/layout";
import { Toaster } from "@/components/ui/toast";
import { AuthProvider } from "@/lib/auth";
import { requireAuth } from "@/lib/auth/guards";
import { isFinanceDashboardEnabled } from "@/lib/feature-flags/server";

/**
 * Back-office layout — guarded by `super_admin` realm role.
 *
 * Non-super-admin users get a 404 (not a 403) so the admin surface is not
 * discoverable via authorisation-error probing — per doc 22 §6.4.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const auth = await requireAuth();
  if (!auth.roles.includes("super_admin")) {
    notFound();
  }

  // Resolve the finance-dashboard flag SSR so the sidebar entry never
  // pops in after hydration (off-state QA per `feedback_feature_flag_first`).
  const financeDashboardEnabled = await isFinanceDashboardEnabled();

  return (
    <AuthProvider>
      <AppShell
        impersonation={auth.impersonation}
        impersonationUserName={undefined}
        isSuperAdmin
        financeDashboardEnabled={financeDashboardEnabled}
      >
        {children}
      </AppShell>
      <Toaster />
    </AuthProvider>
  );
}
