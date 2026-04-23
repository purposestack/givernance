import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AuthCard } from "@/components/auth/auth-card";
import { AuthLogo } from "@/components/auth/auth-logo";
import { OrgPickerClient } from "@/components/auth/org-picker";
import { createServerApiClient } from "@/lib/api/client-server";
import { JWT_COOKIE_NAME } from "@/lib/auth/keycloak";

export const dynamic = "force-dynamic";

/**
 * Org picker interstitial (issue #112 / doc 22 §6.3).
 *
 * Server-rendered — we fetch the user's memberships from `/v1/users/me/organizations`
 * using the JWT cookie, then hand off to the client component for card selection.
 * If the user belongs to zero or one tenant, we skip the picker and redirect
 * straight to the dashboard so the screen never flashes empty-state for a
 * solo-tenant user.
 */
export default async function SelectOrganizationPage() {
  const t = await getTranslations("auth.selectOrganization");
  const cookieStore = await cookies();
  if (!cookieStore.get(JWT_COOKIE_NAME)) {
    redirect("/login");
  }

  const api = await createServerApiClient();
  interface Membership {
    orgId: string;
    slug: string;
    name: string;
    status: string;
    role: string;
    firstAdmin: boolean;
    provisionalUntil: string | null;
    primaryDomain: string | null;
    lastVisitedAt: string | null;
  }

  let memberships: Membership[] = [];
  try {
    const res = await api.get<{ data: Membership[] }>("/v1/users/me/organizations");
    memberships = res.data;
  } catch {
    // If the API call fails, let the client side render an error state.
  }

  if (memberships.length === 1 && memberships[0]) {
    redirect("/dashboard");
  }
  if (memberships.length === 0) {
    redirect("/login?error=no_tenants");
  }

  const lastOrgCookie = cookieStore.get("gv-last-org")?.value;

  return (
    <main
      id="main-content"
      className="flex min-h-screen flex-col items-center justify-center gap-8 bg-background p-6"
    >
      <AuthCard>
        <AuthLogo />
        <h1 className="mb-2 text-center font-heading text-xl text-text">{t("title")}</h1>
        <p className="mb-8 text-center text-sm text-text-secondary">{t("subtitle")}</p>

        <OrgPickerClient memberships={memberships} defaultOrgId={lastOrgCookie} />
      </AuthCard>
    </main>
  );
}
