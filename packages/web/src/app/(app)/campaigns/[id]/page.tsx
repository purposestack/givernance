import { ArrowLeft, CircleHelp, Gift, Globe, Pencil } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { CampaignRoiChart } from "@/components/campaigns/campaign-roi-chart";
import { CampaignStatusActions } from "@/components/campaigns/campaign-status-actions";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ApiProblem } from "@/lib/api";
import { createServerApiClient } from "@/lib/api/client-server";
import { hasPermission, requireAuth } from "@/lib/auth/guards";
import { formatCurrency, formatDate, formatNumber, formatPercent } from "@/lib/format";
import type { Campaign, CampaignRoiMetrics, CampaignStats } from "@/models/campaign";
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
  const auth = await requireAuth();
  const canWrite = hasPermission(auth, "write");
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

  const [stats, roiMetrics, donationsResult, t, tCampaigns, tDonations, locale] = await Promise.all(
    [
      CampaignService.getCampaignStats(client, id),
      CampaignService.getCampaignRoi(client, id),
      fetchDonationsOrEmpty(id, donationsPage, donationsPerPage),
      getTranslations("campaigns.detail"),
      getTranslations("campaigns"),
      getTranslations("donations"),
      getLocale(),
    ],
  );
  const totalCostDisplayValue =
    roiMetrics.totalCostCents > 0
      ? formatCurrency(roiMetrics.totalCostCents, locale)
      : t("roi.unavailable");
  const raisedDisplayValue = formatCurrency(roiMetrics.rawRaisedCents, locale);
  const roiDisplayValue =
    roiMetrics.roiPct !== null ? formatPercent(roiMetrics.roiPct, locale, 1) : t("roi.unavailable");

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
            {canWrite ? (
              <Button asChild size="sm">
                <Link href={`/campaigns/${campaign.id}/edit`}>
                  <Pencil size={16} aria-hidden="true" />
                  {t("actions.edit")}
                </Link>
              </Button>
            ) : null}
            {auth.roles.includes("org_admin") ? (
              <Button asChild variant="secondary" size="sm">
                <Link href={`/campaigns/${campaign.id}/public-page`}>
                  <Globe size={16} aria-hidden="true" />
                  {t("actions.publicPage")}
                </Link>
              </Button>
            ) : null}
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(280px,340px)_minmax(0,1fr)]">
        <aside className="space-y-6">
          <StatsCard campaign={campaign} stats={stats} roiMetrics={roiMetrics} locale={locale} />
          <StatusCard campaign={campaign} canManage={auth.roles.includes("org_admin")} />
        </aside>
        <div className="space-y-6">
          <CampaignRoiChart
            costCents={roiMetrics.totalCostCents > 0 ? roiMetrics.totalCostCents : null}
            totalRaisedCents={roiMetrics.rawRaisedCents}
            roi={roiMetrics.roiPct}
            locale={locale}
            labels={{
              title: t("roi.title"),
              subtitle: t("roi.subtitle"),
              cost: t("roi.totalCost"),
              raised: t("roi.raised"),
              roi: t("roi.roi"),
              metric: t("roi.metric"),
              amount: t("roi.amount"),
              unavailable: t("roi.unavailable"),
              tableCaption: t("roi.tableCaption"),
              chartSummary: t("roi.chartSummary", {
                raised: raisedDisplayValue,
                cost: totalCostDisplayValue,
                roi: roiDisplayValue,
              }),
              chartSummaryUnavailable: t("roi.chartSummaryUnavailable", {
                raised: raisedDisplayValue,
                cost: totalCostDisplayValue,
              }),
            }}
          />
          <CostBreakdownCard metrics={roiMetrics} locale={locale} />
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
  roiMetrics,
  locale,
}: {
  campaign: Campaign;
  stats: CampaignStats;
  roiMetrics: CampaignRoiMetrics;
  locale: string;
}) {
  const t = await getTranslations("campaigns.detail");

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("stats.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="space-y-4">
          <StatRow
            label={t("stats.raised")}
            value={formatCurrency(roiMetrics.rawRaisedCents, locale)}
            hint={t("stats.goalHint", {
              goal:
                campaign.goalAmountCents !== null
                  ? formatCurrency(campaign.goalAmountCents, locale)
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
            hint={t("stats.updatedHint", {
              date: formatDate(campaign.updatedAt, locale, "medium"),
            })}
          />
        </dl>
      </CardContent>
    </Card>
  );
}

async function CostBreakdownCard({
  metrics,
  locale,
}: {
  metrics: CampaignRoiMetrics;
  locale: string;
}) {
  const t = await getTranslations("campaigns.detail");
  const operationalCost =
    metrics.rawOperationalCostCents !== null
      ? formatCurrency(metrics.rawOperationalCostCents, locale)
      : t("roi.unavailable");
  const platformFees = formatCurrency(metrics.rawPlatformFeesCents, locale);
  const totalCost =
    metrics.totalCostCents > 0
      ? formatCurrency(metrics.totalCostCents, locale)
      : t("roi.unavailable");

  return (
    <Card>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <CardHeader className="gap-2">
          <div className="flex items-center gap-2">
            <CardTitle>{t("roi.breakdownTitle")}</CardTitle>
            <TooltipProvider delayDuration={150}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex size-7 items-center justify-center rounded-full text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface"
                    aria-label={t("roi.breakdownTooltipLabel")}
                  >
                    <CircleHelp size={16} aria-hidden="true" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-72 text-sm leading-relaxed">
                  {t("roi.breakdownTooltip")}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <CardDescription>{t("roi.breakdownSubtitle")}</CardDescription>
        </CardHeader>
        <span className="w-full rounded-xl bg-surface-container px-4 py-3 font-mono text-lg font-semibold tabular-nums text-on-surface sm:max-w-52 lg:w-auto">
          {totalCost}
        </span>
      </div>
      <CardContent className="grid gap-4 sm:grid-cols-3">
        <StatRow label={t("roi.operationalCost")} value={operationalCost} />
        <StatRow label={t("roi.platformFees")} value={platformFees} />
        <StatRow label={t("roi.totalCost")} value={totalCost} />
      </CardContent>
    </Card>
  );
}

async function StatusCard({ campaign, canManage }: { campaign: Campaign; canManage: boolean }) {
  const t = await getTranslations("campaigns.detail");

  // For non-admins the card is informational, not actionable — show the
  // current status badge with a single read-only note so we don't end up
  // with a redundant "Status actions" title + duplicate description copy
  // around buttons that aren't there.
  if (!canManage) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("statusCard.readOnlyTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <StatusBadge status={campaign.status} />
          <p className="text-sm text-on-surface-variant">{t("actions.readOnly")}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("actions.title")}</CardTitle>
        <CardDescription>{t("actions.description")}</CardDescription>
      </CardHeader>
      <CampaignStatusActions
        campaignId={campaign.id}
        status={campaign.status}
        canManage={canManage}
      />
    </Card>
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
    <Card>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
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
        <EmptyState
          icon={Gift}
          title={t("donations.title")}
          description={t("donations.empty")}
          className="px-0 py-8"
        />
      ) : (
        <DonationsTable donations={donations} pagination={pagination} />
      )}
    </Card>
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
