import { CalendarClock, CheckCircle2, Circle, Lightbulb, Plus } from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";

import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { ApiProblem } from "@/lib/api";
import { createServerApiClient } from "@/lib/api/client-server";
import { requireAuth } from "@/lib/auth/guards";
import { formatCurrency, formatDate, formatNumber } from "@/lib/format";
import type { Campaign, CampaignStats } from "@/models/campaign";
import type { ConstituentListResponse } from "@/models/constituent";
import type { DonationListRow } from "@/models/donation";
import { donationDonorName } from "@/models/donation";
import { CampaignService } from "@/services/CampaignService";
import { ConstituentService } from "@/services/ConstituentService";
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
  const t = (await getTranslations("dashboard")) as unknown as DashboardT;
  const locale = await getLocale();
  const client = await createServerApiClient();

  const [recentDonations, kpiDonations, donorResult, activeCampaigns] = await Promise.all([
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
  ]);

  const activeCampaignStats = await getActiveCampaignStats(activeCampaigns?.data ?? []);
  const totalRaisedCents = (kpiDonations?.data ?? []).reduce(
    (sum, donation) => sum + donation.amountCents,
    0,
  );
  const primaryCurrency = kpiDonations?.data[0]?.currency ?? "EUR";
  const newDonorsThisMonth = countCreatedThisMonth(donorResult?.data ?? []);
  const activeCampaignCount = activeCampaigns?.pagination.total ?? 0;

  return (
    <div className="space-y-6 sm:space-y-8">
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
          value={formatCurrency(totalRaisedCents, locale, primaryCurrency)}
          description={t("stats.totalRaisedHint")}
          valueClassName="font-mono"
        />
        <StatCard
          label={t("stats.activeCampaigns")}
          value={formatNumber(activeCampaignCount, locale)}
          description={t("stats.activeCampaignsHint")}
        />
        <StatCard
          label={t("stats.donors")}
          value={formatNumber(donorResult?.pagination.total ?? 0, locale)}
          description={t("stats.newDonorsThisMonth", { count: newDonorsThisMonth })}
        />
        <StatCard
          label={t("stats.grantDeadlines")}
          value={t("stats.noGrantDeadlinesValue")}
          description={t("stats.noGrantDeadlinesHint")}
        />
      </section>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(340px,0.65fr)]">
        <section className="rounded-2xl bg-surface-container-lowest p-5 shadow-card sm:p-6">
          <SectionHeader
            title={t("recentDonations.title")}
            actionHref="/donations"
            actionLabel={t("viewAll")}
          />
          <div className="mt-4 divide-y divide-outline-variant/50">
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

        <section className="rounded-2xl bg-surface-container-lowest p-5 shadow-card sm:p-6">
          <SectionHeader
            title={t("quickActions.title")}
            description={t("quickActions.description")}
          />
          <div className="mt-4 grid gap-3 sm:grid-cols-3 xl:grid-cols-1">
            <QuickAction href="/donations/new" label={t("quickActions.newDonation")} />
            <QuickAction href="/constituents/new" label={t("quickActions.newConstituent")} />
            <QuickAction href="/campaigns/new" label={t("quickActions.newCampaign")} />
          </div>
        </section>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(340px,0.65fr)]">
        <section className="rounded-2xl bg-surface-container-lowest p-5 shadow-card sm:p-6">
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

        <div className="space-y-6">
          <section className="rounded-2xl border border-primary/20 bg-ai-bg p-5 shadow-card sm:p-6">
            <div className="flex items-center gap-2 text-ai-text">
              <Lightbulb size={18} aria-hidden="true" />
              <h2 className="font-heading text-xl leading-tight">{t("aiSuggestion.title")}</h2>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-on-surface">{t("aiSuggestion.body")}</p>
          </section>

          <section className="rounded-2xl bg-surface-container-lowest p-5 shadow-card sm:p-6">
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

function countCreatedThisMonth(constituents: ConstituentListResponse["data"]) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return constituents.filter((constituent) => new Date(constituent.createdAt) >= start).length;
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

function StatCard({
  label,
  value,
  description,
  valueClassName,
}: {
  label: string;
  value: string;
  description: string;
  valueClassName?: string;
}) {
  return (
    <article className="min-h-36 rounded-2xl bg-surface-container-lowest p-5 shadow-card">
      <p className="text-sm font-medium text-on-surface-variant">{label}</p>
      <p
        className={`mt-3 font-heading text-4xl font-normal leading-tight text-on-surface ${valueClassName ?? ""}`.trim()}
      >
        {value}
      </p>
      <p className="mt-2 text-sm text-on-surface-variant">{description}</p>
    </article>
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
    <Button asChild variant="secondary" className="justify-start">
      <Link href={href}>
        <Plus size={16} aria-hidden="true" />
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
          {formatCurrency(raisedCents, locale)}
        </span>
      </div>
      <div className="mt-4 h-2 overflow-hidden rounded-md bg-surface-container">
        <div className="h-full rounded-md bg-primary" style={{ width: `${progress}%` }} />
      </div>
      <p className="mt-2 text-xs text-on-surface-variant">
        {goalCents > 0
          ? translate("campaigns.progressWithGoal", {
              progress,
              goal: formatCurrency(goalCents, locale),
            })
          : translate("campaigns.progressWithoutGoal", {
              donations: stats?.donationCount ?? 0,
            })}
      </p>
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
