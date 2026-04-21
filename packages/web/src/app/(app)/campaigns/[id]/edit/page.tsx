import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { CampaignForm } from "@/components/campaigns/campaign-form";
import { PageHeader } from "@/components/shared/page-header";
import { ApiProblem } from "@/lib/api";
import { createServerApiClient } from "@/lib/api/client-server";
import { requireAuth } from "@/lib/auth/guards";
import type { Campaign } from "@/models/campaign";
import { CampaignService } from "@/services/CampaignService";

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
  await requireAuth();
  const { id } = await params;
  const campaign = await fetchCampaignOrNotFound(id);

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
      <CampaignForm mode="edit" campaign={campaign} />
    </>
  );
}
