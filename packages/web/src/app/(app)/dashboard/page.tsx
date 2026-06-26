import {
  Banknote,
  CalendarClock,
  CheckCircle2,
  Circle,
  Lightbulb,
  Megaphone,
  Plus,
  Timer,
  Users,
} from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";

import { cascadeStyle, StatCard, type StatCardTrendData } from "@/components/dashboard/stat-card";
import { CountUp } from "@/components/shared/count-up";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { CurrencyAmount } from "@/components/ui/currency-amount";
import { ApiProblem } from "@/lib/api";
import { createServerApiClient } from "@/lib/api/client-server";
import { hasPermission, requireAuth } from "@/lib/auth/guards";
import { isoDay, monthBoundsUtc } from "@/lib/dashboard-period";
import { formatCurrency, formatCurrencyRounded, formatDate, formatNumber } from "@/lib/format";
import type { Campaign, CampaignStats } from "@/models/campaign";
import type { DashboardPeriod } from "@/models/dashboard";
import type { DonationListRow } from "@/models/donation";
import { donationDonorName } from "@/models/donation";
import { CampaignService } from "@/services/CampaignService";
import { ConstituentService } from "@/services/ConstituentService";
import { DashboardService } from "@/services/DashboardService";
import { DonationService } from "@/services/DonationService";

const RECENT_DONATIONS_LIMIT = 5;
const KPI_SAMPLE_LIMIT = 100;

type DashboardT = (key: string, values?: Record<string, unknown>) => string;
type DashboardTranslate = (key: string, values?: Record<string, string | number>) => string;

interface CampaignWithStats {
  campaign: Campaign;
  stats: CampaignStats | null;
}

/**
 * Dashboard page — protected, requires authentication.
 * The app shell (sidebar, topbar) is provided by the (app) layout.
 */
export default async function DashboardPage() {
  const auth = await requireAuth();
  // Quick Actions are write-only affordances — all three CTAs link to
  // `requireWrite`-gated POST endpoints (constituents in PR #170, donations
  // in #176, campaigns already correct), so hiding them for `viewer` matches
  // the API surface exactly.
  const canWrite = hasPermission(auth, "write");
  const t = (await getTranslations("dashboard")) as unknown as DashboardT;
  const locale = await getLocale();
  const client = await createServerApiClient();

  const [recentDonations, kpiDonations, donorResult, activeCampaigns, stats] = await Promise.all([
    getSafeData(() =>
      DonationService.listDonations(client, { page: 1, perPage: RECENT_DONATIONS_LIMIT }),
    ),
    getSafeData(() =>
      DonationService.listDonations(client, { page: 1, perPage: KPI_SAMPLE_LIMIT }),
    ),
    getSafeData(() =>
      ConstituentService.listConstituents(client, {
        page: 1,
        perPage: KPI_SAMPLE_LIMIT,
        type: "donor",
      }),
    ),
    getSafeData(() =>
      CampaignService.listCampaigns(client, { page: 1, perPage: 5, status: "active" }),
    ),
    getSafeData(() => DashboardService.getStats(client)),
  ]);

  const activeCampaignStats = await getActiveCampaignStats(activeCampaigns?.data ?? []);
  const totalRaisedCents = stats?.totalRaisedCents.current ?? 0;
  const primaryCurrency = kpiDonations?.data[0]?.currency ?? "EUR";
  const mct = stats?.multiCurrencyTotal;
  const newDonorsThisMonth = stats?.newDonors.current ?? 0;
  const activeCampaignCount = activeCampaigns?.pagination.total ?? 0;
  const trendLabel = t("stats.trendLabel");
  const trendRaised = buildTrend(stats?.totalRaisedCents, trendLabel, (cents) =>
    formatCurrencyRounded(cents, locale, primaryCurrency),
  );
  const trendCampaigns = buildTrend(stats?.newActiveCampaigns, trendLabel, (n) =>
    formatNumber(n, locale),
  );
  const trendDonors = buildTrend(stats?.newDonors, trendLabel, (n) => formatNumber(n, locale));

  // Issue #229 — explicit time bounds per card + deep links to the detailed
  // report. The month window mirrors the API's `monthRanges()` (calendar
  // month, UTC, half-open) so the label and the deep-linked donations range
  // agree with the aggregated figure (the donations list treats a date-only
  // `dateTo` as inclusive end-of-day, matching the half-open aggregate).
  const now = new Date();
  const { monthStart, monthLastDay } = monthBoundsUtc(now);
  const monthLabel = new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(now);
  // Same UTC convention as monthLabel/monthBoundsUtc — never the server's
  // local zone, or the two labels could disagree around midnight.
  const todayLabel = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(now);
  const detailAria = (label: string) => t("stats.openDetailAria", { label });

  return (
    <div className="space-y-6 sm:space-y-8">
      {/* ADR-035 rule A1 — the page title is static shell, never animated;
          only the content blocks below participate in the cascade. */}
      <div>
        <h1 className="font-heading text-4xl font-normal leading-tight text-on-surface sm:text-5xl">
          {t("greeting", { name: auth.firstName ?? "" })}
        </h1>
        <p className="mt-2 max-w-3xl text-base text-on-surface-variant sm:text-lg">
          {t("subtitle")}
        </p>
      </div>

      <section
        aria-label={t("stats.ariaLabel")}
        className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"
      >
        <StatCard
          label={t("stats.totalRaised")}
          value={
            // A genuinely FX-converted total renders through CurrencyAmount
            // (ADR-032 §2.13) — it owns the `≈` prefix, the conversion tooltip
            // and the SR announcement. The single-currency case keeps main's
            // CountUp animation, which the aggregate variant can't carry.
            mct ? (
              <CurrencyAmount
                variant="aggregate"
                rounded
                locale={locale}
                data={{
                  originalAmount: mct.totalDisplayCents,
                  originalCurrency: mct.displayCurrency,
                }}
              />
            ) : (
              <CountUp
                value={totalRaisedCents / 100}
                locale={locale}
                formatOptions={{
                  style: "currency",
                  currency: primaryCurrency,
                  minimumFractionDigits: 0,
                  maximumFractionDigits: 0,
                }}
              />
            )
          }
          description={t("stats.totalRaisedHint")}
          period={t("stats.periodCurrentMonth", { month: monthLabel })}
          href={`/donations?dateFrom=${isoDay(monthStart)}&dateTo=${isoDay(monthLastDay)}`}
          hrefAriaLabel={detailAria(t("stats.totalRaised"))}
          valueClassName="font-mono"
          icon={Banknote}
          color="primary"
          trend={trendRaised}
          cascadeIndex={0}
        />
        <StatCard
          label={t("stats.activeCampaigns")}
          value={<CountUp value={activeCampaignCount} locale={locale} />}
          description={t("stats.activeCampaignsHint")}
          period={t("stats.periodAsOf", { date: todayLabel })}
          href="/campaigns?status=active"
          hrefAriaLabel={detailAria(t("stats.activeCampaigns"))}
          icon={Megaphone}
          color="secondary"
          trend={trendCampaigns}
          cascadeIndex={1}
        />
        <StatCard
          label={t("stats.donors")}
          value={<CountUp value={donorResult?.pagination.total ?? 0} locale={locale} />}
          description={t("stats.newDonorsThisMonth", { count: newDonorsThisMonth })}
          period={t("stats.periodAllTime")}
          // Both param spellings on purpose: with `constituents.multi_type`
          // OFF the list page only reads the legacy `?type=`, with the flag
          // ON it reads `?types=` and ignores `type` — sending both keeps
          // the deep link filtering in either flag state (issue #229 review).
          href="/constituents?type=donor&types=donor"
          hrefAriaLabel={detailAria(t("stats.donors"))}
          icon={Users}
          color="tertiary"
          trend={trendDonors}
          cascadeIndex={2}
        />
        <StatCard
          label={t("stats.grantDeadlines")}
          value={t("stats.noGrantDeadlinesValue")}
          description={t("stats.noGrantDeadlinesHint")}
          icon={Timer}
          color="amber"
          cascadeIndex={3}
        />
      </section>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(340px,0.65fr)]">
        <section
          className="reveal-item rounded-2xl bg-surface-container-lowest p-5 border border-border-brand sm:p-6"
          style={cascadeStyle(4)}
        >
          <SectionHeader
            title={t("recentDonations.title")}
            actionHref="/donations"
            actionLabel={t("viewAll")}
          />
          <div className="cascade mt-4 divide-y divide-outline-variant/50">
            {(recentDonations?.data ?? []).length > 0 ? (
              recentDonations?.data.map((donation) => (
                <DonationFeedItem key={donation.id} donation={donation} t={t} locale={locale} />
              ))
            ) : (
              <EmptyState
                icon={CalendarClock}
                title={t("recentDonations.title")}
                description={t("recentDonations.empty")}
                className="px-0 py-8"
              />
            )}
          </div>
        </section>

        {canWrite ? (
          <section
            className="reveal-item rounded-2xl bg-surface-container-lowest p-5 border border-border-brand sm:p-6"
            style={cascadeStyle(5)}
          >
            <SectionHeader
              title={t("quickActions.title")}
              description={t("quickActions.description")}
            />
            <div className="cascade mt-4 grid gap-3 sm:grid-cols-3 xl:grid-cols-1">
              <QuickAction href="/donations/new" label={t("quickActions.newDonation")} />
              <QuickAction href="/constituents/new" label={t("quickActions.newConstituent")} />
              <QuickAction href="/campaigns/new" label={t("quickActions.newCampaign")} />
            </div>
          </section>
        ) : null}
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(340px,0.65fr)]">
        <section
          className="reveal-item rounded-2xl bg-surface-container-lowest p-5 border border-border-brand sm:p-6"
          style={cascadeStyle(6)}
        >
          <SectionHeader
            title={t("campaigns.title")}
            actionHref="/campaigns"
            actionLabel={t("viewAll")}
          />
          <div className="mt-5 space-y-4">
            {activeCampaignStats.length > 0 ? (
              activeCampaignStats.map((item) => (
                <CampaignProgressItem key={item.campaign.id} item={item} t={t} locale={locale} />
              ))
            ) : (
              <EmptyState
                icon={Circle}
                title={t("campaigns.title")}
                description={t("campaigns.empty")}
                className="px-0 py-8"
              />
            )}
          </div>
        </section>

        <div className="reveal-item space-y-6" style={cascadeStyle(6)}>
          <section className="rounded-2xl border border-primary/20 bg-ai-bg p-5 sm:p-6">
            <div className="flex items-center gap-2 text-ai-text">
              <Lightbulb size={18} aria-hidden="true" />
              <h2 className="font-heading text-xl leading-tight">{t("aiSuggestion.title")}</h2>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-on-surface">{t("aiSuggestion.body")}</p>
          </section>

          <section className="rounded-2xl bg-surface-container-lowest p-5 border border-border-brand sm:p-6">
            <SectionHeader
              title={t("onboarding.title")}
              description={t("onboarding.description")}
            />
            <ul className="mt-4 space-y-3">
              <ChecklistItem
                complete={Boolean(donorResult?.pagination.total)}
                label={t("onboarding.addConstituents")}
              />
              <ChecklistItem
                complete={Boolean(recentDonations?.pagination.total)}
                label={t("onboarding.recordDonation")}
              />
              <ChecklistItem
                complete={Boolean(activeCampaignCount)}
                label={t("onboarding.launchCampaign")}
              />
            </ul>
          </section>
        </div>
      </div>
    </div>
  );

  async function getActiveCampaignStats(campaigns: Campaign[]): Promise<CampaignWithStats[]> {
    return Promise.all(
      campaigns.map(async (campaign) => ({
        campaign,
        stats: await getSafeData(() => CampaignService.getCampaignStats(client, campaign.id)),
      })),
    );
  }
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

function buildTrend(
  period: DashboardPeriod | undefined,
  label: string,
  format: (n: number) => string,
): StatCardTrendData | undefined {
  if (!period || period.previous === 0) return undefined;
  const value = Math.round(((period.current - period.previous) / period.previous) * 100);
  return {
    value,
    label,
    detail: { current: format(period.current), previous: format(period.previous) },
  };
}

function SectionHeader({
  title,
  description,
  actionHref,
  actionLabel,
}: {
  title: string;
  description?: string;
  actionHref?: string;
  actionLabel?: string;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h2 className="font-heading text-xl leading-tight text-on-surface">{title}</h2>
        {description ? <p className="mt-1 text-sm text-on-surface-variant">{description}</p> : null}
      </div>
      {actionHref && actionLabel ? (
        <Button asChild variant="ghost" size="sm">
          <Link href={actionHref}>{actionLabel}</Link>
        </Button>
      ) : null}
    </div>
  );
}

function DonationFeedItem({
  donation,
  t,
  locale,
}: {
  donation: DonationListRow;
  t: DashboardT;
  locale: string;
}) {
  const donorName = donationDonorName(donation) ?? t("recentDonations.anonymous");

  return (
    <Link
      href={`/donations/${donation.id}`}
      className="grid gap-2 py-3 transition-colors hover:text-primary sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
    >
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-on-surface">{donorName}</p>
        <p className="text-xs text-on-surface-variant">
          {formatDate(donation.donatedAt, locale, "medium")}
        </p>
      </div>
      <span className="font-mono text-sm font-semibold tabular-nums text-on-surface">
        {formatCurrency(donation.amountCents, locale, donation.currency)}
      </span>
    </Link>
  );
}

function QuickAction({ href, label }: { href: string; label: string }) {
  return (
    <Button asChild variant="secondary" className="group justify-start">
      <Link href={href}>
        <div className="mr-1 flex h-6 w-6 items-center justify-center rounded-full bg-primary-50 text-primary transition-colors group-hover:bg-primary group-hover:text-on-primary">
          <Plus size={14} aria-hidden="true" />
        </div>
        {label}
      </Link>
    </Button>
  );
}

function CampaignProgressItem({
  item,
  t,
  locale,
}: {
  item: CampaignWithStats;
  t: DashboardT;
  locale: string;
}) {
  const { campaign, stats } = item;
  const raisedCents = stats?.totalRaisedCents ?? 0;
  const goalCents = campaign.goalAmountCents ?? 0;
  const progress = goalCents > 0 ? Math.min(Math.round((raisedCents / goalCents) * 100), 100) : 0;
  const translate = t as unknown as DashboardTranslate;

  return (
    <article className="rounded-2xl border border-outline-variant/60 p-4 sm:p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-on-surface">{campaign.name}</h3>
          <p className="mt-1 flex items-center gap-1 text-xs text-on-surface-variant">
            <CalendarClock size={14} aria-hidden="true" />
            {t("campaigns.activeSince", { date: formatDate(campaign.createdAt, locale, "medium") })}
          </p>
        </div>
        <span className="font-mono text-sm font-semibold text-on-surface">
          {formatCurrencyRounded(raisedCents, locale)}
        </span>
      </div>
      {goalCents > 0 ? (
        <>
          <div className="mt-4 h-2 overflow-hidden rounded-md bg-surface-container">
            {/* ADR-035 rules A7/E18 — the width is static (server-resolved);
                the entrance draws via the shared .meter-reveal clip-path
                sweep (delay auto-chains from this card's cascade slot).
                --meter-radius matches rounded-md (8px) so the sweeping
                edge keeps its rounded caps. */}
            <div
              className="meter-reveal h-full rounded-md bg-secondary"
              style={{ width: `${progress}%`, "--meter-radius": "8px" } as React.CSSProperties}
            />
          </div>
          <p className="mt-2 text-xs text-on-surface-variant">
            {translate("campaigns.progressWithGoal", {
              progress,
              goal: formatCurrencyRounded(goalCents, locale),
            })}
          </p>
        </>
      ) : (
        <p className="mt-2 text-xs text-on-surface-variant">
          {translate("campaigns.progressWithoutGoal", {
            donations: stats?.donationCount ?? 0,
          })}
        </p>
      )}
    </article>
  );
}

function ChecklistItem({ complete, label }: { complete: boolean; label: string }) {
  const Icon = complete ? CheckCircle2 : Circle;

  return (
    <li className="flex items-start gap-3 text-sm text-on-surface">
      <Icon
        size={18}
        aria-hidden="true"
        className={complete ? "mt-0.5 shrink-0 text-primary" : "mt-0.5 shrink-0 text-outline"}
      />
      <span>{label}</span>
    </li>
  );
}
