import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import { getTranslations } from "next-intl/server";

import { CampaignForm } from "@/components/campaigns/campaign-form";
import { fetchCustomFieldDefinitionsOrEmpty } from "@/components/shared/custom-fields";
import { PageHeader } from "@/components/shared/page-header";
import { createServerApiClient } from "@/lib/api/client-server";
import { requirePermission } from "@/lib/auth/guards";
import { FeatureFlagsService, isFlagEnabled } from "@/services/FeatureFlagsService";

export default async function NewCampaignPage() {
  await requirePermission("write");
  const t = await getTranslations("campaigns.form");
  const tCampaigns = await getTranslations("campaigns");

  // Epic #539 — flag off / fetch failure ⇒ no defs ⇒ no custom section.
  let customFieldsEnabled = false;
  const client = await createServerApiClient();
  try {
    const flags = await FeatureFlagsService.listPublic(client);
    customFieldsEnabled = isFlagEnabled(flags, FEATURE_FLAG_KEYS.CAMPAIGNS_CUSTOM_FIELDS);
  } catch {
    customFieldsEnabled = false;
  }
  const customFieldDefs = await fetchCustomFieldDefinitionsOrEmpty(
    client,
    "campaign",
    customFieldsEnabled,
  );

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
        <CampaignForm mode="create" customFieldDefs={customFieldDefs} />
      </div>
    </>
  );
}
