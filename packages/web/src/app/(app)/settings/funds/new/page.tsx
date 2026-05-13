import { getTranslations } from "next-intl/server";

import { FundForm } from "@/components/settings/fund-form";
import { SettingsNavigation } from "@/components/settings/settings-navigation";
import { PageHeader } from "@/components/shared/page-header";
import { requireAuth } from "@/lib/auth/guards";
import { isFeatureFlagsPhase2Enabled } from "@/lib/feature-flags/server";

export default async function NewFundPage() {
  const auth = await requireAuth();
  const t = await getTranslations("settings.funds");
  const tSettings = await getTranslations("settings");
  const tForm = await getTranslations("settings.funds.form");
  const showFeatureFlags = await isFeatureFlagsPhase2Enabled();

  return (
    <>
      <PageHeader
        title={tForm("createTitle")}
        description={tForm("createSubtitle")}
        breadcrumbs={[
          { label: tSettings("breadcrumbRoot"), href: "/dashboard" },
          { label: t("settings"), href: "/settings" },
          { label: t("title"), href: "/settings/funds" },
          { label: tForm("breadcrumbNew") },
        ]}
      />
      <SettingsNavigation showFeatureFlags={showFeatureFlags} />
      <FundForm mode="create" canManageFunds={auth.roles.includes("org_admin")} />
    </>
  );
}
