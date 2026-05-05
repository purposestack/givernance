import { getTranslations } from "next-intl/server";
import { LogoUploadCard } from "@/components/branding/logo-upload-card";
import { SettingsNavigation } from "@/components/settings/settings-navigation";
import { SettingsSnapshotPanel } from "@/components/settings/settings-snapshot-panel";
import { StripeConnectPanel } from "@/components/settings/stripe-connect-panel";
import { TenantSettingsForm } from "@/components/settings/tenant-settings-form";
import { PageHeader } from "@/components/shared/page-header";
import { createServerApiClient } from "@/lib/api/client-server";
import { requireAuth } from "@/lib/auth/guards";

/**
 * Settings page — protected, requires authentication.
 * Phase 1 exposes the minimum viable organisation settings surface
 * needed for tenant snapshot export demo flows.
 *
 * Epic #286: visual-identity hero card sits at the top, before the
 * settings sub-navigation, so the logo affordance is the first thing
 * an operator sees when they land here.
 */
export default async function SettingsPage() {
  const auth = await requireAuth();
  const t = await getTranslations("settings");

  // Resolve the current org name server-side so the InitialLetterAvatar
  // fallback renders with the right glyph on first paint (no flash from
  // client hydration). Tolerate a missing /v1/users/me — the LogoUploadCard
  // happily falls back to "?" if `orgName` is empty.
  let orgName = "";
  try {
    const api = await createServerApiClient();
    const me = await api.get<{ data: { orgName?: string } }>("/v1/users/me");
    orgName = me.data.orgName ?? "";
  } catch {
    // Non-fatal — the card still renders with a generic glyph.
  }

  const canManageBranding = auth.roles.includes("org_admin");

  return (
    <div className="space-y-8">
      <PageHeader
        title={t("title")}
        description={t("subtitle")}
        breadcrumbs={[{ label: t("breadcrumbRoot"), href: "/dashboard" }, { label: t("title") }]}
      />
      <div id="branding">
        <LogoUploadCard
          orgName={orgName}
          tenantId={auth.orgId}
          canManageBranding={canManageBranding}
        />
      </div>
      <SettingsNavigation />
      <TenantSettingsForm orgId={auth.orgId} canManageTenant={auth.roles.includes("org_admin")} />
      <StripeConnectPanel canManageTenant={auth.roles.includes("org_admin")} />
      <SettingsSnapshotPanel orgId={auth.orgId} canExport={auth.roles.includes("org_admin")} />
    </div>
  );
}
