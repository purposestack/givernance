import { Filter, Users } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiProblem } from "@/lib/api";
import { createServerApiClient } from "@/lib/api/client-server";
import { requirePermission } from "@/lib/auth/guards";
import type { Campaign } from "@/models/campaign";
import { CampaignService } from "@/services/CampaignService";

import { AddConstituentsContent } from "./add-constituents-content";

interface AddConstituentsPageProps {
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

export default async function AddConstituentsPage({ params }: AddConstituentsPageProps) {
  await requirePermission("write");

  const { id } = await params;
  const campaign = await fetchCampaignOrNotFound(id);

  const [t, tCampaigns] = await Promise.all([
    getTranslations("campaigns.addConstituents"),
    getTranslations("campaigns"),
  ]);

  // Door drop campaigns don't have recipients
  if (campaign.type === "door_drop") {
    return (
      <>
        <PageHeader
          title={t("title")}
          breadcrumbs={[
            { label: tCampaigns("breadcrumbRoot"), href: "/dashboard" },
            { label: tCampaigns("title"), href: "/campaigns" },
            { label: campaign.name, href: `/campaigns/${campaign.id}` },
            { label: t("breadcrumb") },
          ]}
        />
        <Card>
          <CardContent className="py-12">
            <EmptyState
              icon={Users}
              title={t("doorDrop.title")}
              description={t("doorDrop.description")}
              action={
                <Button asChild>
                  <Link href={`/campaigns/${campaign.id}`}>{t("doorDrop.action")}</Link>
                </Button>
              }
            />
          </CardContent>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={t("title")}
        description={t("subtitle", { campaignName: campaign.name })}
        breadcrumbs={[
          { label: tCampaigns("breadcrumbRoot"), href: "/dashboard" },
          { label: tCampaigns("title"), href: "/campaigns" },
          { label: campaign.name, href: `/campaigns/${campaign.id}` },
          { label: t("breadcrumb") },
        ]}
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href={`/campaigns/${campaign.id}`}>{t("actions.skipForNow")}</Link>
          </Button>
        }
      />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Filter size={18} aria-hidden="true" />
              {t("advancedFilters.title")}
            </CardTitle>
            <CardDescription>{t("advancedFilters.description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <AddConstituentsContent campaignId={campaign.id} mode="filter" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users size={18} aria-hidden="true" />
              {t("simpleSearch.title")}
            </CardTitle>
            <CardDescription>{t("simpleSearch.description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <AddConstituentsContent campaignId={campaign.id} mode="search" />
          </CardContent>
        </Card>
      </div>
    </>
  );
}
