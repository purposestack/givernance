import { ArrowLeft, Pencil } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { CampaignRoiChart } from "@/components/campaigns/campaign-roi-chart";
import { CampaignStatusActions } from "@/components/campaigns/campaign-status-actions";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ApiProblem } from "@/lib/api";
import { createServerApiClient } from "@/lib/api/client-server";
import { requireAuth } from "@/lib/auth/guards";
import { formatCurrency, formatDate, formatNumber } from "@/lib/format";
import type { Campaign, CampaignStats } from "@/models/campaign";
import type { DonationListResponse } from "@/models/donation";
import { CampaignService } from "@/services/CampaignService";
import { DonationService } from "@/services/DonationService";

import { DonationsTable } from "./donations-table";

const DEFAULT_DONATIONS_PER_PAGE = 25;
const MAX_DONATIONS_PER_PAGE = 100;

interface CampaignDetailPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function parsePositiveInt(value: string | string[] | undefined, fallback: number, max?: number) {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return max ? Math.min(parsed, max) : parsed;
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

async function fetchDonationsOrEmpty(
  id: string,
  page: number,
  perPage: number,
): Promise<DonationListResponse> {
  const client = await createServerApiClient();
  try {
    return await DonationService.listDonations(client, {
      campaignId: id,
      page,
      perPage,
    });
  } catch (err) {
    if (err instanceof ApiProblem && (err.status === 401 || err.status === 403)) {
      return {
        data: [],
        pagination: { page, perPage, total: 0, totalPages: 0 },
      };
    }
    throw err;
  }
}

export default async function CampaignDetailPage({
  params,
  searchParams,
}: CampaignDetailPageProps) {
  await requireAuth();
  const { id } = await params;
  const sp = await searchParams;
  const donationsPage = parsePositiveInt(sp.page, 1);
  const donationsPerPage = parsePositiveInt(
    sp.perPage,
    DEFAULT_DONATIONS_PER_PAGE,
    MAX_DONATIONS_PER_PAGE,
  );

  const client = await createServerApiClient();
  const campaign = await fetchCampaignOrNotFound(id);

  const [stats, donationsResult, t, tCampaigns, tDonations, locale] = await Promise.all([
    CampaignService.getCampaignStats(client, id),
    fetchDonationsOrEmpty(id, donationsPage, donationsPerPage),
    getTranslations("campaigns.detail"),
    getTranslations("campaigns"),
    getTranslations("donations"),
    getLocale(),
  ]);
  const roi = CampaignService.calculateRoi(campaign.costCents, stats.totalRaisedCents);

  return (
    <>
      <PageHeader
        title={campaign.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={campaign.status} />
            <Badge variant="info">{tCampaigns(`types.${campaign.type}`)}</Badge>
          </span>
        }
        breadcrumbs={[
          { label: tCampaigns("breadcrumbRoot"), href: "/dashboard" },
          { label: tCampaigns("title"), href: "/campaigns" },
          { label: campaign.name },
        ]}
        actions={
          <>
            <Button asChild variant="ghost" size="sm">
              <Link href="/campaigns">
                <ArrowLeft size={16} aria-hidden="true" />
                {t("actions.back")}
              </Link>
            </Button>
            <Button asChild size="sm">
              <Link href={`/campaigns/${campaign.id}/edit`}>
                <Pencil size={16} aria-hidden="true" />
                {t("actions.edit")}
              </Link>
            </Button>
          </>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
        <aside className="space-y-6">
          <StatsCard campaign={campaign} stats={stats} locale={locale} />
          <StatusCard campaign={campaign} />
        </aside>
        <div className="space-y-6">
          <CampaignRoiChart
            costCents={campaign.costCents}
            totalRaisedCents={stats.totalRaisedCents}
            roi={roi}
            locale={locale}
            labels={{
              title: t("roi.title"),
              subtitle: t("roi.subtitle"),
              cost: t("roi.cost"),
              raised: t("roi.raised"),
              roi: t("roi.roi"),
              metric: t("roi.metric"),
              amount: t("roi.amount"),
              unavailable: t("roi.unavailable"),
              tableCaption: t("roi.tableCaption"),
              chartSummary: t("roi.chartSummary"),
              chartSummaryUnavailable: t("roi.chartSummaryUnavailable"),
            }}
          />
          <DonationBreakdownCard
            campaign={campaign}
            donationsResult={donationsResult}
            donationsLabel={tDonations("title")}
          />
        </div>
      </div>
    </>
  );
}

async function StatsCard({
  campaign,
  stats,
  locale,
}: {
  campaign: Campaign;
  stats: CampaignStats;
  locale: string;
}) {
  const t = await getTranslations("campaigns.detail");

  return (
    <section className="rounded-2xl bg-surface-container-lowest p-6 shadow-card">
      <h2 className="mb-4 font-heading text-xl text-on-surface">{t("stats.title")}</h2>
      <dl className="space-y-4">
        <StatRow
          label={t("stats.raised")}
          value={formatCurrency(stats.totalRaisedCents, locale)}
          hint={t("stats.goalHint", {
            goal:
              campaign.costCents !== null
                ? formatCurrency(campaign.costCents, locale)
                : t("stats.noGoal"),
          })}
        />
        <StatRow
          label={t("stats.donors")}
          value={formatNumber(stats.uniqueDonors, locale)}
          hint={t("stats.donationsHint", { count: stats.donationCount })}
        />
        <StatRow
          label={t("stats.created")}
          value={formatDate(campaign.createdAt, locale, "long")}
          hint={t("stats.updatedHint", { date: formatDate(campaign.updatedAt, locale, "medium") })}
        />
      </dl>
    </section>
  );
}

async function StatusCard({ campaign }: { campaign: Campaign }) {
  const t = await getTranslations("campaigns.detail");

  return (
    <section className="rounded-2xl bg-surface-container-lowest p-6 shadow-card">
      <h2 className="mb-4 font-heading text-xl text-on-surface">{t("actions.title")}</h2>
      <p className="mb-4 text-sm text-on-surface-variant">{t("actions.description")}</p>
      <CampaignStatusActions campaignId={campaign.id} status={campaign.status} />
    </section>
  );
}

async function DonationBreakdownCard({
  campaign,
  donationsResult,
  donationsLabel,
}: {
  campaign: Campaign;
  donationsResult: DonationListResponse;
  donationsLabel: string;
}) {
  const t = await getTranslations("campaigns.detail");
  const { data: donations, pagination } = donationsResult;

  return (
    <section className="rounded-2xl bg-surface-container-lowest p-6 shadow-card">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="font-heading text-xl text-on-surface">{t("donations.title")}</h2>
          <p className="text-sm text-on-surface-variant">
            {t("donations.subtitle", { count: pagination.total })}
          </p>
        </div>
        <Button asChild variant="ghost" size="sm">
          <Link href={`/donations?campaignId=${encodeURIComponent(campaign.id)}`}>
            {donationsLabel}
          </Link>
        </Button>
      </div>

      {donations.length === 0 ? (
        <p className="text-sm text-on-surface-variant">{t("donations.empty")}</p>
      ) : (
        <DonationsTable donations={donations} pagination={pagination} />
      )}
    </section>
  );
}

function StatRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl bg-surface-container p-4">
      <dt className="text-sm text-on-surface-variant">{label}</dt>
      <dd className="mt-1 font-mono text-2xl font-semibold tabular-nums text-on-surface">
        {value}
      </dd>
      {hint ? <p className="mt-1 text-xs text-on-surface-variant">{hint}</p> : null}
    </div>
  );
}

function StatusBadge({ status }: { status: Campaign["status"] }) {
  const variants = {
    draft: "neutral",
    active: "success",
    closed: "info",
  } as const;

  return <TranslatedStatusBadge status={status} variant={variants[status]} />;
}

async function TranslatedStatusBadge({
  status,
  variant,
}: {
  status: Campaign["status"];
  variant: "neutral" | "success" | "info";
}) {
  const t = await getTranslations("campaigns");
  return <Badge variant={variant}>{t(`status.${status}`)}</Badge>;
}
