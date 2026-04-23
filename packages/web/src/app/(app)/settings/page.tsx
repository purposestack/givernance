import { getTranslations } from "next-intl/server";
import { SettingsSnapshotPanel } from "@/components/settings/settings-snapshot-panel";
import { TenantSettingsForm } from "@/components/settings/tenant-settings-form";
import { PageHeader } from "@/components/shared/page-header";
import { requireAuth } from "@/lib/auth/guards";

/**
 * Settings page — protected, requires authentication.
 * Phase 1 exposes the minimum viable organisation settings surface
 * needed for tenant snapshot export demo flows.
 */
export default async function SettingsPage() {
  const auth = await requireAuth();
  const t = await getTranslations("settings");

  return (
    <div className="space-y-8">
      <PageHeader
        title={t("title")}
        description={t("subtitle")}
        breadcrumbs={[{ label: t("breadcrumbRoot"), href: "/dashboard" }, { label: t("title") }]}
      />
      <TenantSettingsForm orgId={auth.orgId} canManageTenant={auth.roles.includes("org_admin")} />
      <SettingsSnapshotPanel orgId={auth.orgId} canExport={auth.roles.includes("org_admin")} />
    </div>
  );
}
