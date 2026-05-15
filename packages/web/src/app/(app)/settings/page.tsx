import { getTranslations } from "next-intl/server";
import { SettingsNavigation } from "@/components/settings/settings-navigation";
import { SettingsSnapshotPanel } from "@/components/settings/settings-snapshot-panel";
import { StripeConnectPanel } from "@/components/settings/stripe-connect-panel";
import { TenantSettingsForm } from "@/components/settings/tenant-settings-form";
import { PageHeader } from "@/components/shared/page-header";
import { createServerApiClient } from "@/lib/api/client-server";
import { requireAuth } from "@/lib/auth/guards";
import { isFeatureFlagsPhase2Enabled } from "@/lib/feature-flags/server";

/**
 * Settings page — protected, requires authentication.
 * Phase 1 exposes the minimum viable organisation settings surface
 * needed for tenant snapshot export demo flows.
 *
 * Epic #286: the visual-identity (logo) section is rendered INSIDE the
 * Organisation card via `TenantSettingsForm`'s embedded variant — it
 * sits at the top of the card, alongside currency / locale / mission,
 * not as a separate hero above the settings sub-navigation.
 *
 * Epic #362 update: the public-donation-page **style picker** does NOT
 * live here. It lives per-campaign inside the campaign-public-page
 * editor at `/campaigns/[id]/public-page` — one style per campaign is
 * the right scope (operator feedback). The `/v1/org/style-default`
 * API endpoint + `tenants.default_public_page_style` column stay in
 * place as a deliberate-no-op fallback layer in the three-tier
 * resolution; bringing the org-level UI back is a UI-only change if
 * we ever want an org-wide default again.
 */
export default async function SettingsPage() {
  const auth = await requireAuth();
  const t = await getTranslations("settings");

  // Resolve the current org name server-side so the InitialLetterAvatar
  // fallback inside the embedded logo upload renders with the right
  // glyph on first paint. Tolerate a missing /v1/users/me.
  let orgName = "";
  try {
    const api = await createServerApiClient();
    const me = await api.get<{ data: { orgName?: string } }>("/v1/users/me");
    orgName = me.data.orgName ?? "";
  } catch {
    // Non-fatal — the form falls back to the tenant name from its own load.
  }

  const canManageBranding = auth.roles.includes("org_admin");
  // Phase 2 (Epic #365): only surface the Feature flags nav entry when
  // the self-flag is on. Fail-closed (off) on projection errors.
  const showFeatureFlags = await isFeatureFlagsPhase2Enabled();

  return (
    <div className="space-y-8">
      <PageHeader
        title={t("title")}
        description={t("subtitle")}
        breadcrumbs={[{ label: t("breadcrumbRoot"), href: "/dashboard" }, { label: t("title") }]}
      />
      <SettingsNavigation showFeatureFlags={showFeatureFlags} />
      <TenantSettingsForm
        orgId={auth.orgId}
        canManageTenant={auth.roles.includes("org_admin")}
        orgName={orgName}
        canManageBranding={canManageBranding}
      />
      <StripeConnectPanel canManageTenant={auth.roles.includes("org_admin")} />
      <SettingsSnapshotPanel orgId={auth.orgId} canExport={auth.roles.includes("org_admin")} />
    </div>
  );
}
