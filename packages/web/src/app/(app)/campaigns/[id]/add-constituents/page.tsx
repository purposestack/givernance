import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
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
import { requireOrgAdmin } from "@/lib/auth/guards";
import type { Campaign } from "@/models/campaign";
import { CampaignService } from "@/services/CampaignService";
import { FeatureFlagsService, isFlagEnabled } from "@/services/FeatureFlagsService";

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
  // Every recipient endpoint (`/v1/campaigns/:id/constituents`, the filter
  // bulk-add) is `requireOrgAdmin` — docs/23 §7. A `write` page guard let
  // role `user` in, only to hit a guaranteed 403 on submit (issue #614).
  await requireOrgAdmin();

  const { id } = await params;
  const campaign = await fetchCampaignOrNotFound(id);

  // Epic #418 — with `advanced_filters` off the "Advanced filters" card is
  // completely absent (its preview/bulk-add endpoints 404). Fail-closed.
  let advancedFiltersEnabled = false;
  try {
    const flags = await FeatureFlagsService.listPublic(await createServerApiClient());
    advancedFiltersEnabled = isFlagEnabled(flags, FEATURE_FLAG_KEYS.ADVANCED_FILTERS);
  } catch {
    advancedFiltersEnabled = false;
  }

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

      <div className={advancedFiltersEnabled ? "grid gap-6 lg:grid-cols-2" : "grid gap-6"}>
        {advancedFiltersEnabled ? (
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
        ) : null}

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
