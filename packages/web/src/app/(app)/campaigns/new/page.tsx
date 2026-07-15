import { getTranslations } from "next-intl/server";

import { CampaignForm } from "@/components/campaigns/campaign-form";
import { PageHeader } from "@/components/shared/page-header";
import { requirePermission } from "@/lib/auth/guards";

export default async function NewCampaignPage() {
  await requirePermission("write");
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
      {/* ADR-035 rule A2 — single entrance slot for the form container;
          header/shell stay static (rule A1). The wrapper animates
          opacity/transform only — zero layout shift (rule A6). */}
      <div className="reveal-item">
        <CampaignForm mode="create" />
      </div>
    </>
  );
}
