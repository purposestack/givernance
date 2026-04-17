import { requireAuth } from "@/lib/auth/guards";

/**
 * Dashboard page — protected, requires authentication.
 * The app shell (sidebar, topbar) is provided by the (app) layout.
 * Placeholder for Sprint 4 PR-C1 implementation.
 */
export default async function DashboardPage() {
  const auth = await requireAuth();

  return (
    <>
      <div className="mb-8">
        <h1 className="font-heading text-5xl font-normal leading-tight tracking-tight text-on-surface">
          Bonjour{auth.firstName ? `, ${auth.firstName}` : ""}
        </h1>
        <p className="mt-2 text-lg text-on-surface-variant">
          Voici l&apos;activité de votre organisation aujourd&apos;hui.
        </p>
      </div>

      {/* Placeholder — KPI widgets and dashboard content will be built in PR-C1 */}
      <div className="rounded-2xl bg-surface-container-lowest p-8 shadow-card">
        <p className="text-sm text-text-secondary">
          Dashboard content under construction (Sprint 4, PR-C1).
        </p>
      </div>
    </>
  );
}
