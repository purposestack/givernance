import { requireAuth } from "@/lib/auth/guards";

/**
 * Dashboard page — protected, requires authentication.
 * Placeholder for Sprint 4 PR-B1+ implementation.
 */
export default async function DashboardPage() {
  const auth = await requireAuth();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-8">
      <div className="text-center">
        <h1 className="font-heading text-2xl text-text">Dashboard</h1>
        <p className="mt-2 text-sm text-text-secondary">
          Welcome{auth.firstName ? `, ${auth.firstName}` : ""}. Dashboard under construction (Sprint
          4).
        </p>
      </div>
    </div>
  );
}
