import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { CampaignForm } from "@/components/campaigns/campaign-form";
import { fetchCustomFieldDefinitionsOrEmpty } from "@/components/shared/custom-fields";
import { PageHeader } from "@/components/shared/page-header";
import { ApiProblem } from "@/lib/api";
import { createServerApiClient } from "@/lib/api/client-server";
import { requirePermission } from "@/lib/auth/guards";
import type { Campaign } from "@/models/campaign";
import { CampaignService } from "@/services/CampaignService";
import { FeatureFlagsService, isFlagEnabled } from "@/services/FeatureFlagsService";

interface EditCampaignPageProps {
  params: Promise<{ id: string }>;
}

async function fetchCampaignOrNotFound(id: string): Promise<Campaign> {
  const client = await createServerApiClient();
  try {
    return await CampaignService.getCampaign(client, id);
  } catch (err) {
    if (err instanceof ApiProblem && err.status === 404) {
      notFound();
    }
    throw err;
  }
}

export default async function EditCampaignPage({ params }: EditCampaignPageProps) {
  await requirePermission("write");
  const { id } = await params;
  const campaign = await fetchCampaignOrNotFound(id);

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

  const t = await getTranslations("campaigns.form");
  const tCampaigns = await getTranslations("campaigns");

  return (
    <>
      <PageHeader
        title={t("editTitle")}
        description={t("editSubtitle")}
        breadcrumbs={[
          { label: tCampaigns("breadcrumbRoot"), href: "/dashboard" },
          { label: tCampaigns("title"), href: "/campaigns" },
          { label: campaign.name, href: `/campaigns/${campaign.id}` },
          { label: t("breadcrumbEdit") },
        ]}
      />
      <CampaignForm mode="edit" campaign={campaign} customFieldDefs={customFieldDefs} />
    </>
  );
}
