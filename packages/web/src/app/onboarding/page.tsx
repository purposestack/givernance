import { redirect } from "next/navigation";
import { OnboardingWizard } from "@/components/onboarding";
import { requireAuth } from "@/lib/auth/guards";
import { getTenantMe } from "@/services/tenant-service";

/**
 * Onboarding entry page (scope-reduced #40 PR-A4).
 *
 * Server component that:
 * 1. Requires an authenticated session (redirects to /login otherwise).
 * 2. Loads the current user's tenant via GET /v1/tenants/me.
 * 3. Redirects to /dashboard if onboarding is already complete.
 * 4. Renders the 5-step wizard hydrated with any previously saved Step 1 data.
 *
 * Steps 2–4 are placeholders that link to #78 (Phase 2 — Complete onboarding
 * wizard). Mockups are preserved at `docs/design/auth/onboarding-{2..4}.html`
 * for Phase 2.
 */
export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  await requireAuth();

  const tenant = await getTenantMe();

  if (tenant?.onboardingCompletedAt) {
    redirect("/dashboard");
  }

  const { error } = await searchParams;

  return <OnboardingWizard initialTenant={tenant} serverErrorKey={error} />;
}
