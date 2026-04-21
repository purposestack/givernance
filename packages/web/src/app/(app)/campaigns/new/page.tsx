import { getTranslations } from "next-intl/server";

import { CampaignForm } from "@/components/campaigns/campaign-form";
import { PageHeader } from "@/components/shared/page-header";
import { requireAuth } from "@/lib/auth/guards";

export default async function NewCampaignPage() {
  await requireAuth();
  const t = await getTranslations("campaigns.form");
  const tCampaigns = await getTranslations("campaigns");

  return (
    <>
      <PageHeader
        title={t("createTitle")}
        description={t("createSubtitle")}
        breadcrumbs={[
          { label: tCampaigns("breadcrumbRoot"), href: "/dashboard" },
          { label: tCampaigns("title"), href: "/campaigns" },
          { label: t("breadcrumbNew") },
        ]}
      />
      <CampaignForm mode="create" />
    </>
  );
}
