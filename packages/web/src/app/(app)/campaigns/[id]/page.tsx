import { ArrowLeft, Pencil } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { CampaignStatusActions } from "@/components/campaigns/campaign-status-actions";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ApiProblem } from "@/lib/api";
import { createServerApiClient } from "@/lib/api/client-server";
import { requireAuth } from "@/lib/auth/guards";
import { formatCurrency, formatDate, formatNumber } from "@/lib/format";
import type { Campaign, CampaignStats } from "@/models/campaign";
import type { DonationListRow } from "@/models/donation";
import { donationDonorName } from "@/models/donation";
import { CampaignService } from "@/services/CampaignService";
import { DonationService } from "@/services/DonationService";

interface CampaignDetailPageProps {
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

export default async function CampaignDetailPage({ params }: CampaignDetailPageProps) {
  await requireAuth();
  const { id } = await params;
  const client = await createServerApiClient();
  const campaign = await fetchCampaignOrNotFound(id);

  const [stats, donations, t, tCampaigns, tDonations, locale] = await Promise.all([
    CampaignService.getCampaignStats(client, id),
    DonationService.listDonations(client, { campaignId: id, perPage: 100 }),
    getTranslations("campaigns.detail"),
    getTranslations("campaigns"),
    getTranslations("donations"),
    getLocale(),
  ]);

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
        <DonationBreakdownCard
          campaign={campaign}
          donations={donations.data}
          locale={locale}
          donationsLabel={tDonations("title")}
        />
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
  donations,
  locale,
  donationsLabel,
}: {
  campaign: Campaign;
  donations: DonationListRow[];
  locale: string;
  donationsLabel: string;
}) {
  const t = await getTranslations("campaigns.detail");

  return (
    <section className="rounded-2xl bg-surface-container-lowest p-6 shadow-card">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="font-heading text-xl text-on-surface">{t("donations.title")}</h2>
          <p className="text-sm text-on-surface-variant">
            {t("donations.subtitle", { count: donations.length })}
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
        <table className="w-full border-separate border-spacing-0 text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wide text-on-surface-variant">
              <th className="border-b border-outline-variant py-2 text-left font-medium">
                {t("donations.columns.date")}
              </th>
              <th className="border-b border-outline-variant py-2 text-left font-medium">
                {t("donations.columns.donor")}
              </th>
              <th className="border-b border-outline-variant py-2 text-left font-medium">
                {t("donations.columns.reference")}
              </th>
              <th className="border-b border-outline-variant py-2 text-right font-medium">
                {t("donations.columns.amount")}
              </th>
            </tr>
          </thead>
          <tbody>
            {donations.map((donation) => (
              <tr key={donation.id}>
                <td className="border-b border-outline-variant/50 py-3 text-on-surface-variant">
                  {formatDate(donation.donatedAt, locale, "medium")}
                </td>
                <td className="border-b border-outline-variant/50 py-3">
                  <Link
                    href={`/donations/${donation.id}`}
                    className="font-medium text-on-surface hover:text-primary hover:underline"
                  >
                    {donationDonorName(donation) ?? t("donations.anonymousDonor")}
                  </Link>
                </td>
                <td className="border-b border-outline-variant/50 py-3 text-on-surface-variant">
                  {donation.paymentRef ?? t("donations.noReference")}
                </td>
                <td className="border-b border-outline-variant/50 py-3 text-right font-mono tabular-nums text-on-surface">
                  {formatCurrency(donation.amountCents, locale, donation.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
