import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import { getLocale } from "next-intl/server";
import { cache } from "react";
import { AppShell } from "@/components/layout";
import { SurveyInvitationPrompt } from "@/components/surveys/survey-invitation-prompt";
import { Toaster } from "@/components/ui/toast";
import { ApiProblem } from "@/lib/api";
import { createServerApiClient } from "@/lib/api/client-server";
import { AuthProvider } from "@/lib/auth";
import { requireAuth } from "@/lib/auth/guards";
import type { OrgLogo } from "@/models/branding";
import { FeatureFlagsService, isFlagEnabled } from "@/services/FeatureFlagsService";

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
 *
 * FE-1 (PR #118 review): both the provisional-admin banner and the org
 * switcher depend on `/v1/users/me*` responses. `React.cache` dedupes the
 * two fetches within a single request render.
 */
const fetchMeWithMembership = cache(async () => {
  const api = await createServerApiClient();
  const [meRes, orgsRes] = await Promise.allSettled([
    api.get<{
      data: {
        firstAdmin?: boolean;
        provisionalUntil?: string | null;
        orgSlug?: string;
      };
    }>("/v1/users/me"),
    api.get<{ data: Array<{ orgId: string }> }>("/v1/users/me/organizations"),
  ]);
  return {
    me: meRes.status === "fulfilled" ? meRes.value.data : null,
    membershipCount: orgsRes.status === "fulfilled" ? orgsRes.value.data.length : undefined,
  };
});

/**
 * Resolve the active org logo server-side (Epic #286 / PR #287 review,
 * major 4). The Sidebar + AddLogoBanner used to each fetch this from
 * the browser on every navigation, costing 2 GETs per nav and flashing
 * the initial-letter avatar before the sidebar logo arrived. Hoisting
 * the fetch into the (app) layout removes both the per-nav refetch and
 * the flash.
 *
 * `React.cache` dedupes the call across the layout tree within a single
 * server render (the LogoUploadCard sits below this layout but it owns
 * its own polling + upload state, so it intentionally still fetches
 * client-side; the initial paint there reuses this server result via
 * the `initialLogo` prop).
 *
 * Returns `null` for super-admins (no orgId) and on any failure path —
 * the UI falls back to the InitialLetterAvatar.
 */
const fetchOrgLogo = cache(async (orgId: string | undefined): Promise<OrgLogo | null> => {
  if (!orgId) return null;
  try {
    const api = await createServerApiClient();
    const raw = await api.get<{ data: OrgLogo | null } | OrgLogo | null>("/v1/branding/org-logo");
    if (raw === null || raw === undefined) return null;
    if (typeof raw === "object" && "data" in raw) {
      return (raw.data ?? null) as OrgLogo | null;
    }
    return raw as OrgLogo;
  } catch (err) {
    // Treat 404s + transient failures as "no logo" — never block the
    // shell's render on a branding fetch.
    if (err instanceof ApiProblem && err.status === 404) return null;
    return null;
  }
});

/**
 * Resolve the tenant-public feature-flag projection server-side so the
 * topbar can render the notifications bell (Epic #363) on first paint
 * without a hydration flash. Soft-fails to an empty list — every
 * downstream `isFlagEnabled` call falls back to `false` (doc 18 §5)
 * which is the safe default for a brand-new feature.
 */
const fetchPublicFlags = cache(async () => {
  try {
    const api = await createServerApiClient();
    return await FeatureFlagsService.listPublic(api);
  } catch {
    return [];
  }
});

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const auth = await requireAuth();
  const isSuperAdmin = auth.roles.includes("super_admin");
  const locale = (await getLocale()) === "fr" ? "fr" : "en";

  const userName = auth.firstName ? `${auth.firstName} ${auth.lastName ?? ""}`.trim() : auth.email;

  const [{ me, membershipCount }, orgLogo, publicFlags] = await Promise.all([
    fetchMeWithMembership(),
    fetchOrgLogo(auth.orgId),
    fetchPublicFlags(),
  ]);

  const notificationsEnabled = isFlagEnabled(
    publicFlags,
    FEATURE_FLAG_KEYS.COMMUNICATION_NOTIFICATIONS_CENTER,
  );
  const commandPaletteEnabled = isFlagEnabled(
    publicFlags,
    FEATURE_FLAG_KEYS.PRODUCTIVITY_COMMAND_PALETTE,
  );
  // Super-admin sidebar item "Platform finance" must stay visible across
  // every authenticated route — not just `/admin/*`. Without this, a
  // super-admin browsing to /dashboard or /constituents loses the
  // navigation handle back to the platform finance view (and any other
  // super-admin entry the sidebar adds). The (admin) layout resolves
  // the same flag; this mirror keeps the (app) layout in lockstep.
  const financeDashboardEnabled = isFlagEnabled(
    publicFlags,
    FEATURE_FLAG_KEYS.ADMIN_FINANCE_DASHBOARD,
  );

  // Broken state: a non-super-admin reached the authenticated layout but
  // we couldn't resolve their tenant memberships. Two failure modes:
  //   - `membershipCount === undefined`: `/v1/users/me/organizations`
  //     rejected (transient 5xx, network blip).
  //   - `membershipCount === 0`: the user has no active memberships —
  //     usually a JWT that outlived a tenant-removal, which the auth
  //     plugin's active-row check (ADR-021) is supposed to catch
  //     upstream; landing here means the check was bypassed somehow.
  //
  // Either way the user has nothing to do in the app — silently
  // rendering a half-broken sidebar / data-less dashboard would mask
  // a real bug. Throwing surfaces it in logs + Next.js's error boundary
  // so we can investigate. Super-admins are exempt: they legitimately
  // have zero tenant memberships by design (ADR-022).
  if (!isSuperAdmin && (membershipCount === undefined || membershipCount === 0)) {
    throw new Error(
      `Authenticated tenant user has no resolvable memberships (membershipCount=${membershipCount}). ` +
        `Check /v1/users/me/organizations and the auth plugin's active-row guard.`,
    );
  }

  let provisionalAdmin: { provisionalUntil: string; orgSlug: string } | undefined;
  if (
    me?.firstAdmin &&
    me.provisionalUntil &&
    me.orgSlug &&
    new Date(me.provisionalUntil) > new Date()
  ) {
    provisionalAdmin = {
      provisionalUntil: me.provisionalUntil,
      orgSlug: me.orgSlug,
    };
  }

  // Super-admins live in `platform_admins` without an org_id (ADR-022)
  // so every TENANT-SCOPED chrome element is meaningless for them:
  //   - 'Add your organisation's logo' banner → no organisation to add a logo to
  //   - Command palette (Cmd+K) → searches constituents/donations/campaigns,
  //     all tenant-scoped, nothing to search across as a platform admin
  //   - Notifications centre → tenant-scoped events, super-admin doesn't
  //     receive any
  // The Keycloak seed gives the demo super-admin BOTH realmRoles=[super_admin]
  // AND attributes.role=[org_admin] (for impersonation testing), which made
  // the naive `auth.roles.includes("org_admin")` check evaluate to true on
  // a super-admin session — that's how the logo banner leaked.
  // (`isSuperAdmin` already resolved at the top of the function.)
  const canManageBranding = !isSuperAdmin && auth.roles.includes("org_admin");

  return (
    <AuthProvider>
      <AppShell
        impersonation={auth.impersonation}
        impersonationUserName={auth.impersonation ? userName : undefined}
        provisionalAdmin={provisionalAdmin}
        membershipCount={membershipCount}
        isSuperAdmin={isSuperAdmin}
        orgId={auth.orgId}
        canManageBranding={canManageBranding}
        orgLogo={orgLogo}
        notificationsEnabled={!isSuperAdmin && notificationsEnabled}
        commandPaletteEnabled={!isSuperAdmin && commandPaletteEnabled}
        financeDashboardEnabled={financeDashboardEnabled}
      >
        {children}
        {!isSuperAdmin && financeDashboardEnabled && <SurveyInvitationPrompt locale={locale} />}
      </AppShell>
      <Toaster />
    </AuthProvider>
  );
}
