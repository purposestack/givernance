import { ArrowLeft, Gift, Globe, Pencil, Trophy } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import type { CSSProperties, ReactNode } from "react";

import { CampaignRoiChart } from "@/components/campaigns/campaign-roi-chart";
import { CampaignStatusActions } from "@/components/campaigns/campaign-status-actions";
import { PostalCampaignSection } from "@/components/campaigns/postal-campaign-section";
import { QrTrackingCard } from "@/components/campaigns/qr-tracking-card";
import { CountUp } from "@/components/shared/count-up";
import { EmptyState } from "@/components/shared/empty-state";
import { InfoTooltipButton } from "@/components/shared/info-tooltip-button";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiProblem } from "@/lib/api";
import { createServerApiClient } from "@/lib/api/client-server";
import { hasPermission, requireAuth } from "@/lib/auth/guards";
import { isPostalMergedPdfEnabled } from "@/lib/feature-flags/server";
import { formatCurrency, formatDate, formatPercent } from "@/lib/format";
import type { Campaign, CampaignRoiMetrics, CampaignStats } from "@/models/campaign";
import type { DonationListResponse, DonationSortField, DonationSortOrder } from "@/models/donation";
import { BankAccountService } from "@/services/BankAccountService";
import { CampaignPublicPageService } from "@/services/CampaignPublicPageService";
import { CampaignService } from "@/services/CampaignService";
import { DonationService } from "@/services/DonationService";
import {
  type CampaignMember,
  type CampaignQrStats,
  PostalCampaignService,
  type PostalExport,
} from "@/services/PostalCampaignService";

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

/**
 * Sortable columns of the Donation breakdown table (a subset of the API's
 * `DONATION_SORT_FIELDS` — the columns actually rendered + server-sortable).
 * Reference has no API sort field, so it's not in here. Sorting is resolved
 * in the DB across the whole list, never client-side over the visible page.
 */
const DONATION_SORT_FIELDS = new Set<DonationSortField>(["donatedAt", "donor", "amountCents"]);

function parseDonationSort(value: string | string[] | undefined): DonationSortField {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw && DONATION_SORT_FIELDS.has(raw as DonationSortField)
    ? (raw as DonationSortField)
    : "donatedAt";
}

function parseDonationOrder(value: string | string[] | undefined): DonationSortOrder {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "asc" ? "asc" : "desc";
}

async function fetchDonationsOrEmpty(
  id: string,
  page: number,
  perPage: number,
  sort: DonationSortField,
  order: DonationSortOrder,
): Promise<DonationListResponse> {
  const client = await createServerApiClient();
  try {
    return await DonationService.listDonations(client, {
      campaignId: id,
      page,
      perPage,
      sort,
      order,
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

/**
 * The postal-campaign endpoints (Epic #274) are gated to `org_admin`. For
 * non-admins we short-circuit to empty data so the page still renders the
 * stats/donations sections without 403 noise.
 */
async function fetchPostalMembersOrEmpty(
  client: Awaited<ReturnType<typeof createServerApiClient>>,
  id: string,
  isAdmin: boolean,
): Promise<{ data: CampaignMember[]; total: number }> {
  if (!isAdmin) return { data: [], total: 0 };
  try {
    // perPage 25 matches `MEMBERS_PER_PAGE` in `CampaignMembersCard`, so the
    // SSR-rendered first page hydrates without an immediate refetch.
    const fresh = await PostalCampaignService.listMembers(client, id, { perPage: 25 });
    return { data: fresh.data, total: fresh.pagination.total };
  } catch {
    return { data: [], total: 0 };
  }
}

async function fetchPostalExportsOrEmpty(
  client: Awaited<ReturnType<typeof createServerApiClient>>,
  id: string,
  isAdmin: boolean,
): Promise<PostalExport[]> {
  if (!isAdmin) return [];
  try {
    return await PostalCampaignService.listExports(client, id);
  } catch {
    return [];
  }
}

/**
 * Epic #318 PR #4 — fetch the campaign's linked bank account (only
 * org_admins can read this surface) so the postal-export panel can
 * render the Swiss QR-bill mode summary. Returns null when no bank
 * account is linked or the campaign is in standard mode.
 *
 * Failure surface (M6): a 404 is the only meaningful "no bank account
 * here" signal (soft-deleted account, or the row vanished between page
 * load and request). Every other status — 401/403/5xx — is a real bug
 * we MUST surface to the operator instead of collapsing to "standard
 * postal mode" and misdirecting them to re-link an account that isn't
 * actually missing. Re-throwing propagates to Next.js's error boundary,
 * which is the right UX: a real error message beats a silent lie.
 */
async function fetchLinkedBankAccountOrNull(
  client: Awaited<ReturnType<typeof createServerApiClient>>,
  bankAccountId: string | null,
  isAdmin: boolean,
): Promise<{ bankName: string; ibanLast4: string; currency: "CHF" | "EUR" } | null> {
  if (!isAdmin || !bankAccountId) return null;
  try {
    const account = await BankAccountService.getBankAccount(client, bankAccountId);
    return {
      bankName: account.bankName,
      ibanLast4: account.iban.slice(-4),
      currency: account.currency,
    };
  } catch (err) {
    if (err instanceof ApiProblem && err.status === 404) return null;
    throw err;
  }
}

/**
 * Best-effort fetch of the campaign's admin public-page record (Epic
 * #274 readiness gate). Returns the page status so the postal export
 * panel can surface "publish before generating" banners. A 404 means
 * the operator has not yet configured the public page at all — distinct
 * from `draft`, and worth a different banner.
 */
async function fetchPublicPageStatus(
  client: Awaited<ReturnType<typeof createServerApiClient>>,
  id: string,
  isAdmin: boolean,
): Promise<"draft" | "published" | "missing"> {
  if (!isAdmin) return "missing";
  try {
    const page = await CampaignPublicPageService.getCampaignPublicPage(client, id);
    return page.status === "published" ? "published" : "draft";
  } catch (err) {
    if (err instanceof ApiProblem && err.status === 404) return "missing";
    return "missing";
  }
}

async function fetchQrStatsOrEmpty(
  client: Awaited<ReturnType<typeof createServerApiClient>>,
  id: string,
  isAdmin: boolean,
): Promise<CampaignQrStats | null> {
  if (!isAdmin) return null;
  try {
    return await PostalCampaignService.getQrStats(client, id);
  } catch {
    return null;
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
  const donationsSort = parseDonationSort(sp.sort);
  const donationsOrder = parseDonationOrder(sp.order);

  const client = await createServerApiClient();
  const campaign = await fetchCampaignOrNotFound(id);

  const isAdmin = auth.roles.includes("org_admin");

  const [
    stats,
    roiMetrics,
    donationsResult,
    membersResult,
    postalExports,
    qrStats,
    publicPageStatus,
    linkedBankAccount,
    mergedPdfEnabled,
    t,
    tCampaigns,
    tDonations,
    locale,
  ] = await Promise.all([
    CampaignService.getCampaignStats(client, id),
    CampaignService.getCampaignRoi(client, id),
    fetchDonationsOrEmpty(id, donationsPage, donationsPerPage, donationsSort, donationsOrder),
    fetchPostalMembersOrEmpty(client, id, isAdmin),
    fetchPostalExportsOrEmpty(client, id, isAdmin),
    fetchQrStatsOrEmpty(client, id, isAdmin),
    fetchPublicPageStatus(client, id, isAdmin),
    fetchLinkedBankAccountOrNull(client, campaign.bankAccountId, isAdmin),
    // Project item #194221573 — only the postal panel (admin-only) needs
    // this; resolve false for non-admins without a wasted projection fetch.
    isAdmin ? isPostalMergedPdfEnabled() : Promise.resolve(false),
    getTranslations("campaigns.detail"),
    getTranslations("campaigns"),
    getTranslations("donations"),
    getLocale(),
  ]);
  const totalCostDisplayValue =
    roiMetrics.totalCostCents > 0
      ? formatCurrency(roiMetrics.totalCostCents, locale)
      : t("roi.unavailable");
  const raisedDisplayValue = formatCurrency(roiMetrics.rawRaisedCents, locale);
  const roiDisplayValue =
    roiMetrics.roiPct !== null ? formatPercent(roiMetrics.roiPct, locale, 1) : t("roi.unavailable");

  // ADR-035 rules A1/A2 — the PageHeader (title, badges, CTAs) is static
  // shell and never animates; content enters via each column's `.cascade`
  // container (nth-child × --stagger-step, cards from slot 1). Client
  // cards inside (members, exports, donations) re-render in place on
  // interaction and Radix dialogs portal out of the container, so
  // nth-child indices never shift post-mount and the entrance never
  // replays on refetch (rule B12).
  return (
    <>
      <PageHeader
        title={campaign.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={campaign.status} />
            <Badge variant="info">{tCampaigns(`types.${campaign.type}`)}</Badge>
            {campaign.bankAccountId !== null ? (
              <Badge variant="success">{tCampaigns("swissQrBillBadge")}</Badge>
            ) : null}
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
        <aside className="cascade space-y-6">
          <StatsCard campaign={campaign} stats={stats} roiMetrics={roiMetrics} locale={locale} />
          <StatusCard campaign={campaign} canManage={auth.roles.includes("org_admin")} />
        </aside>
        <div className="cascade space-y-6">
          <CampaignDescriptionCard
            campaignId={campaign.id}
            description={campaign.description}
            canEdit={canWrite}
          />
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
          {isAdmin && qrStats ? <QrTrackingCard stats={qrStats} /> : null}
          {isAdmin ? (
            <PostalCampaignSection
              campaignId={campaign.id}
              campaignType={campaign.type}
              campaignStatus={campaign.status}
              publicPageStatus={publicPageStatus}
              bankAccount={linkedBankAccount}
              initialMembers={membersResult.data}
              initialMemberTotal={membersResult.total}
              initialExports={postalExports}
              mergedPdfEnabled={mergedPdfEnabled}
            />
          ) : null}
          <DonationBreakdownCard
            campaign={campaign}
            donationsResult={donationsResult}
            donationsLabel={tDonations("title")}
            sort={donationsSort}
            order={donationsOrder}
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
          {campaign.goalAmountCents && campaign.goalAmountCents > 0 ? (
            <GoalProgressRow
              raisedCents={roiMetrics.rawRaisedCents}
              goalCents={campaign.goalAmountCents}
              locale={locale}
              labels={{
                raised: t("stats.raised"),
                progressLabel: t("stats.goalProgressLabel"),
                caption: (progress, goal) => t("stats.goalProgressCaption", { progress, goal }),
                aria: (raised, goal) => t("stats.goalProgressAria", { raised, goal }),
                remaining: (amount) => t("stats.goalRemaining", { amount }),
                reached: t("stats.goalReached"),
              }}
            />
          ) : (
            <StatRow
              label={t("stats.raised")}
              value={formatCurrency(roiMetrics.rawRaisedCents, locale)}
              hint={t("stats.goalHint", { goal: t("stats.noGoal") })}
            />
          )}
          <StatRow
            label={t("stats.donors")}
            value={<CountUp value={stats.uniqueDonors} locale={locale} />}
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

interface GoalProgressLabels {
  raised: string;
  progressLabel: string;
  caption: (progress: number, goal: string) => string;
  aria: (raised: string, goal: string) => string;
  remaining: (amount: string) => string;
  reached: string;
}

function GoalProgressRow({
  raisedCents,
  goalCents,
  locale,
  labels,
}: {
  raisedCents: number;
  goalCents: number;
  locale: string;
  labels: GoalProgressLabels;
}) {
  const ratio = raisedCents / goalCents;
  const progress = Math.round(ratio * 100);
  const cappedProgress = Math.min(progress, 100);
  const remainingCents = Math.max(goalCents - raisedCents, 0);
  const reached = raisedCents >= goalCents;
  const raisedFormatted = formatCurrency(raisedCents, locale);
  const goalFormatted = formatCurrency(goalCents, locale);

  return (
    <div className="rounded-xl bg-surface-container p-4">
      <div className="flex items-baseline justify-between gap-3">
        <dt className="text-sm text-on-surface-variant">{labels.raised}</dt>
        {reached ? (
          <Badge variant="success" className="gap-1 text-[10px] uppercase tracking-wide">
            <Trophy size={12} aria-hidden="true" />
            {labels.reached}
          </Badge>
        ) : null}
      </div>
      <dd className="mt-1 font-mono text-2xl font-semibold tabular-nums text-on-surface">
        {/* ADR-035 rule A7 — the KPI counts up over the same 600 ms window
            as the meter-reveal below so both land together. The Intl options
            mirror formatCurrency's defaults (EUR, two decimals). */}
        <CountUp
          value={raisedCents / 100}
          locale={locale}
          formatOptions={{
            style: "currency",
            currency: "EUR",
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          }}
        />
      </dd>
      <div
        className="mt-3 h-2 overflow-hidden rounded-md bg-surface-container-highest"
        role="progressbar"
        aria-valuenow={cappedProgress}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={labels.aria(raisedFormatted, goalFormatted)}
      >
        {/* ADR-035 rules A7/E18 — the width is static (server-resolved);
            the entrance draws via the shared .meter-reveal clip-path sweep
            (delay auto-chains from the card's cascade slot), never a width
            animation. --meter-radius matches rounded-md (8px) so the
            sweeping edge keeps its rounded caps. */}
        <div
          className={`meter-reveal h-full rounded-md ${reached ? "bg-success" : "bg-secondary"}`}
          style={{ width: `${cappedProgress}%`, "--meter-radius": "8px" } as CSSProperties}
        />
      </div>
      <p className="mt-2 flex items-center justify-between gap-2 text-xs text-on-surface-variant">
        <span>{labels.caption(progress, goalFormatted)}</span>
        {!reached ? (
          <span className="font-mono tabular-nums">
            {labels.remaining(formatCurrency(remainingCents, locale))}
          </span>
        ) : null}
      </p>
    </div>
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
            <InfoTooltipButton
              ariaLabel={t("roi.breakdownTooltipLabel")}
              content={t("roi.breakdownTooltip")}
            />
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

/**
 * Campaign description card on the internal detail page.
 *
 * The same `campaigns.description` string is the source of truth for the
 * postal letter body (Epic #274) and the donor-facing public page seed.
 * Surfacing it on the admin detail page lets the operator verify the
 * copy without opening the edit form, and nudges them to fill it when
 * empty (an empty description shows a muted prompt + edit CTA so the
 * postal export doesn't ship with the generic fallback).
 */
async function CampaignDescriptionCard({
  campaignId,
  description,
  canEdit,
}: {
  campaignId: string;
  description: string | null;
  canEdit: boolean;
}) {
  const t = await getTranslations("campaigns.detail.description");
  const trimmed = description?.trim() ?? "";
  const hasDescription = trimmed.length > 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>{t("title")}</CardTitle>
            <CardDescription>{t("subtitle")}</CardDescription>
          </div>
          {canEdit ? (
            <Button asChild variant="ghost" size="sm">
              <Link href={`/campaigns/${campaignId}/edit`}>
                <Pencil size={14} aria-hidden="true" />
                {t("editAction")}
              </Link>
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        {hasDescription ? (
          // `whitespace-pre-line` so paragraph breaks the operator typed
          // render the way they wrote them — important when the same
          // string flows into the postal letter body (which preserves
          // newlines in PDFKit's text layout).
          <p className="whitespace-pre-line text-sm leading-6 text-on-surface">{trimmed}</p>
        ) : canEdit ? (
          <p className="text-sm text-on-surface-variant">{t("emptyEditable")}</p>
        ) : (
          <p className="text-sm text-on-surface-variant">{t("emptyReadOnly")}</p>
        )}
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
  sort,
  order,
}: {
  campaign: Campaign;
  donationsResult: DonationListResponse;
  donationsLabel: string;
  sort: DonationSortField;
  order: DonationSortOrder;
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
        <DonationsTable donations={donations} pagination={pagination} sort={sort} order={order} />
      )}
    </Card>
  );
}

function StatRow({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
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
    closed: "neutral",
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
