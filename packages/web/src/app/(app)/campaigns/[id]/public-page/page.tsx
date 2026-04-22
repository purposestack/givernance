import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { CampaignPublicPageForm } from "@/components/campaigns/campaign-public-page-form";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { ApiProblem } from "@/lib/api";
import { createServerApiClient } from "@/lib/api/client-server";
import { requireOrgAdmin } from "@/lib/auth/guards";
import type { Campaign } from "@/models/campaign";
import type { CampaignPublicPage } from "@/models/public-page";
import { CampaignPublicPageService } from "@/services/CampaignPublicPageService";
import { CampaignService } from "@/services/CampaignService";

interface CampaignPublicPageEditorPageProps {
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

async function fetchPublicPageOrNull(id: string): Promise<CampaignPublicPage | null> {
  const client = await createServerApiClient();
  try {
    return await CampaignPublicPageService.getCampaignPublicPage(client, id);
  } catch (err) {
    if (err instanceof ApiProblem && err.status === 404) {
      return null;
    }
    throw err;
  }
}

export default async function CampaignPublicPageEditorPage({
  params,
}: CampaignPublicPageEditorPageProps) {
  await requireOrgAdmin();
  const { id } = await params;

  const [campaign, initialPage, t, tCampaigns] = await Promise.all([
    fetchCampaignOrNotFound(id),
    fetchPublicPageOrNull(id),
    getTranslations("campaigns.publicPage"),
    getTranslations("campaigns"),
  ]);

  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("subtitle")}
        breadcrumbs={[
          { label: tCampaigns("breadcrumbRoot"), href: "/dashboard" },
          { label: tCampaigns("title"), href: "/campaigns" },
          { label: campaign.name, href: `/campaigns/${campaign.id}` },
          { label: t("breadcrumb") },
        ]}
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href={`/campaigns/${campaign.id}`}>
              <ArrowLeft size={16} aria-hidden="true" />
              {t("actions.back")}
            </Link>
          </Button>
        }
      />

      <CampaignPublicPageForm campaign={campaign} initialPage={initialPage} />
    </>
  );
}
