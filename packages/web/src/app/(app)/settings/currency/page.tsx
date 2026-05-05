import { getTranslations } from "next-intl/server";
import { CurrencySettingsForm } from "@/components/settings/currency-settings-form";
import { SettingsNavigation } from "@/components/settings/settings-navigation";
import { PageHeader } from "@/components/shared/page-header";
import { requireAuth } from "@/lib/auth/guards";

export default async function CurrencySettingsPage() {
  const auth = await requireAuth();
  const t = await getTranslations("settings");
  const tCurrency = await getTranslations("settings.currency");

  return (
    <div className="space-y-8">
      <PageHeader
        title={t("title")}
        description={t("subtitle")}
        breadcrumbs={[
          { label: t("breadcrumbRoot"), href: "/dashboard" },
          { label: t("title"), href: "/settings" },
          { label: tCurrency("title") },
        ]}
      />
      <SettingsNavigation />
      <CurrencySettingsForm orgId={auth.orgId} canManageTenant={auth.roles.includes("org_admin")} />
    </div>
  );
}
