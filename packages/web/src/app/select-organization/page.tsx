import { TriangleAlert } from "lucide-react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AuthCard } from "@/components/auth/auth-card";
import { AuthLogo } from "@/components/auth/auth-logo";
import { OrgPickerClient } from "@/components/auth/org-picker";
import { ApiProblem } from "@/lib/api";
import { createServerApiClient } from "@/lib/api/client-server";
import { JWT_COOKIE_NAME } from "@/lib/auth/keycloak";

export const dynamic = "force-dynamic";

const RESTORE_RETRY_HREF = "/api/auth/restore-session?return=%2Fselect-organization";

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

  // `null` = the fetch failed; `[]` = the API answered "no memberships".
  // Issue #613: the two used to be conflated, so an API blip redirected a
  // perfectly valid member to `/login?error=no_tenants` (and on to
  // /dashboard via the proxy).
  let memberships: Membership[] | null = null;
  let retryHref = "/select-organization";
  try {
    const res = await api.get<{ data: Membership[] }>("/v1/users/me/organizations");
    memberships = res.data;
  } catch (err) {
    memberships = null;
    // The API rejected a JWT the proxy still considers live (revoked
    // session, rotated key): a plain reload would fail the same way until
    // the token expires, so the retry goes through restore-session instead.
    if (err instanceof ApiProblem && err.status === 401) retryHref = RESTORE_RETRY_HREF;
  }

  if (!memberships) {
    return (
      <main
        id="main-content"
        className="flex min-h-screen flex-col items-center justify-center gap-8 bg-background p-6"
      >
        <AuthCard>
          <AuthLogo />
          <div role="alert" className="text-center">
            <TriangleAlert className="mx-auto mb-4 h-8 w-8 text-error" aria-hidden="true" />
            <h1 className="mb-2 font-heading text-xl text-text">{t("loadError.title")}</h1>
            <p className="mb-8 text-sm text-text-secondary">{t("loadError.description")}</p>
            {/* Plain <a>, never next/link: on a 401 the retry is the
                restore-session GET (rotates the access token, then lands back
                here — or on /login if the session is really gone), which must
                not be prefetched. User-initiated, so it cannot loop. */}
            <a
              href={retryHref}
              className="inline-flex h-[var(--btn-height-lg)] items-center justify-center rounded-button bg-primary px-8 font-body text-base font-medium text-on-primary no-underline transition-opacity duration-normal ease-out hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              {t("loadError.retry")}
            </a>
          </div>
        </AuthCard>
      </main>
    );
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
      {/* ADR-035 (pre-auth surface) — AuthCard itself carries the single
          `.reveal-item` entrance at slot 0 (see auth-card.tsx): the whole
          picker fades/rises once as one block, marketing-hero continuity
          intact. Per the AuthCard contract nothing inside the card gets
          its own choreography — no `.cascade` on the org list (E19-style
          single-container treatment), and the surrounding shell stays
          static (rule A1). */}
      <AuthCard className="max-w-3xl">
        <AuthLogo />
        <h1 className="mb-2 text-center font-heading text-xl text-text">{t("title")}</h1>
        <p className="mb-8 text-center text-sm text-text-secondary">{t("subtitle")}</p>

        <OrgPickerClient memberships={memberships} defaultOrgId={lastOrgCookie} />
      </AuthCard>
    </main>
  );
}
