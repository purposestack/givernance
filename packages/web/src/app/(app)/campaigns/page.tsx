import { Megaphone, Plus } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { ApiProblem } from "@/lib/api";
import { createServerApiClient } from "@/lib/api/client-server";
import { requireAuth } from "@/lib/auth/guards";
import type { CampaignListResponse } from "@/models/campaign";
import { CampaignService } from "@/services/CampaignService";

import { CampaignsTable } from "./campaigns-table";

const DEFAULT_PER_PAGE = 20;
const MAX_PER_PAGE = 100;

interface CampaignsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function parsePositiveInt(value: string | string[] | undefined, fallback: number, max?: number) {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return max ? Math.min(parsed, max) : parsed;
}

export default async function CampaignsPage({ searchParams }: CampaignsPageProps) {
  await requireAuth();
  const params = await searchParams;
  const t = await getTranslations("campaigns");

  const page = parsePositiveInt(params.page, 1);
  const perPage = parsePositiveInt(params.perPage, DEFAULT_PER_PAGE, MAX_PER_PAGE);

  const client = await createServerApiClient();

  let result: CampaignListResponse;
  try {
    result = await CampaignService.listCampaigns(client, { page, perPage });
  } catch (err) {
    if (err instanceof ApiProblem && (err.status === 401 || err.status === 403)) {
      result = {
        data: [],
        pagination: { page, perPage, total: 0, totalPages: 0 },
      };
    } else {
      throw err;
    }
  }

  const campaignsWithStats = await Promise.all(
    result.data.map(async (campaign) => ({
      campaign,
      stats: await getSafeData(() => CampaignService.getCampaignStats(client, campaign.id)),
    })),
  );
  const hasAny = result.pagination.total > 0;

  return (
    <>
      <PageHeader
        title={t("title")}
        description={
          hasAny ? t("subtitleWithCount", { count: result.pagination.total }) : t("subtitleEmpty")
        }
        breadcrumbs={[{ label: t("breadcrumbRoot"), href: "/dashboard" }, { label: t("title") }]}
        actions={
          <Button asChild variant="primary" size="sm">
            <Link href="/campaigns/new">
              <Plus size={16} aria-hidden="true" />
              {t("actions.new")}
            </Link>
          </Button>
        }
      />

      {hasAny ? (
        <CampaignsTable campaigns={campaignsWithStats} pagination={result.pagination} />
      ) : (
        <div className="rounded-2xl bg-surface-container-lowest shadow-card">
          <EmptyState icon={Megaphone} title={t("empty.title")} description={t("empty.seedHint")} />
        </div>
      )}
    </>
  );
}

async function getSafeData<T>(loader: () => Promise<T>): Promise<T | null> {
  try {
    return await loader();
  } catch (err) {
    if (err instanceof ApiProblem && (err.status === 401 || err.status === 403)) {
      return null;
    }
    throw err;
  }
}
