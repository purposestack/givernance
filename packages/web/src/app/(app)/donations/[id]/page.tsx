import { ArrowLeft, Pencil } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { ReceiptPreviewButton } from "@/components/donations/receipt-preview-button";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ApiProblem } from "@/lib/api";
import { createServerApiClient } from "@/lib/api/client-server";
import { requireAuth } from "@/lib/auth/guards";
import { formatCurrency, formatDate } from "@/lib/format";
import type { DonationAllocation, DonationDetail } from "@/models/donation";
import { donationDetailDonorName } from "@/models/donation";
import { DonationService } from "@/services/DonationService";

interface DonationDetailPageProps {
  params: Promise<{ id: string }>;
}

async function fetchDonationOrNotFound(id: string): Promise<DonationDetail> {
  const client = await createServerApiClient();
  try {
    return await DonationService.getDonation(client, id);
  } catch (err) {
    if (err instanceof ApiProblem && err.status === 404) {
      notFound();
    }
    throw err;
  }
}

export default async function DonationDetailPage({ params }: DonationDetailPageProps) {
  await requireAuth();
  const { id } = await params;
  const donation = await fetchDonationOrNotFound(id);

  const [t, tDonations, locale] = await Promise.all([
    getTranslations("donations.detail"),
    getTranslations("donations"),
    getLocale(),
  ]);

  const donorName = donationDetailDonorName(donation) || t("anonymousDonor");
  const amountLabel = formatCurrency(donation.amountCents, locale, donation.currency);

  return (
    <>
      <PageHeader
        title={`${t("title")} — ${amountLabel}`}
        description={donorName}
        breadcrumbs={[
          { label: t("breadcrumbRoot"), href: "/dashboard" },
          { label: tDonations("title"), href: "/donations" },
          { label: amountLabel },
        ]}
        actions={
          <>
            <Button asChild variant="ghost" size="sm">
              <Link href="/donations">
                <ArrowLeft size={16} aria-hidden="true" />
                {t("actions.back")}
              </Link>
            </Button>
            <Button asChild size="sm">
              <Link href={`/donations/${donation.id}/edit`}>
                <Pencil size={16} aria-hidden="true" />
                {t("actions.edit")}
              </Link>
            </Button>
            <ReceiptPreviewButton donationId={donation.id} />
          </>
        }
      />

      <div className="grid gap-6 md:grid-cols-2">
        <InfoCard
          donation={donation}
          donorName={donorName}
          amountLabel={amountLabel}
          locale={locale}
        />
        <AllocationsCard donation={donation} allocations={donation.allocations} locale={locale} />
      </div>
    </>
  );
}

async function InfoCard({
  donation,
  donorName,
  amountLabel,
  locale,
}: {
  donation: DonationDetail;
  donorName: string;
  amountLabel: string;
  locale: string;
}) {
  const t = await getTranslations("donations.detail");

  return (
    <Card className="p-6">
      <h2 className="mb-4 font-heading text-xl text-on-surface">{t("infoSection")}</h2>
      <dl className="space-y-3">
        <DetailRow label={t("fields.donor")}>
          <Link
            href={`/constituents/${donation.constituentId}`}
            className="text-sky-text hover:underline"
          >
            {donorName}
          </Link>
        </DetailRow>
        <DetailRow label={t("fields.date")}>
          {formatDate(donation.donatedAt, locale, "long")}
        </DetailRow>
        <DetailRow label={t("fields.amount")}>
          <span className="font-mono font-semibold tabular-nums">{amountLabel}</span>
        </DetailRow>
        <DetailRow label={t("fields.paymentMethod")}>
          {donation.paymentMethod ?? t("notRecorded")}
        </DetailRow>
        <DetailRow label={t("fields.paymentRef")}>
          {donation.paymentRef ? (
            <span className="font-mono text-sm">{donation.paymentRef}</span>
          ) : (
            t("notRecorded")
          )}
        </DetailRow>
        <DetailRow label={t("fields.campaign")}>
          {donation.campaignId ? (
            <Link
              href={`/campaigns/${donation.campaignId}`}
              className="text-sky-text hover:underline"
            >
              {donation.campaignId}
            </Link>
          ) : (
            t("notRecorded")
          )}
        </DetailRow>
        <DetailRow label={t("fields.fiscalYear")}>{String(donation.fiscalYear)}</DetailRow>
        <DetailRow label={t("fields.recordedAt")}>
          {formatDate(donation.createdAt, locale, "long")}
        </DetailRow>
      </dl>
    </Card>
  );
}

async function AllocationsCard({
  donation,
  allocations,
  locale,
}: {
  donation: DonationDetail;
  allocations: DonationAllocation[];
  locale: string;
}) {
  const t = await getTranslations("donations.detail");

  if (allocations.length === 0) {
    return (
      <Card className="p-6">
        <h2 className="mb-4 font-heading text-xl text-on-surface">{t("allocationsSection")}</h2>
        <p className="text-sm text-on-surface-variant">{t("allocations.empty")}</p>
      </Card>
    );
  }

  const total = allocations.reduce((sum, a) => sum + a.amountCents, 0) || 1;

  return (
    <Card className="p-6">
      <h2 className="mb-4 font-heading text-xl text-on-surface">{t("allocationsSection")}</h2>
      <Table>
        <TableHeader>
          <tr>
            <TableHead>{t("allocations.columnFund")}</TableHead>
            <TableHead className="text-right">{t("allocations.columnAmount")}</TableHead>
            <TableHead className="text-right">{t("allocations.columnPercent")}</TableHead>
          </tr>
        </TableHeader>
        <TableBody>
          {allocations.map((allocation) => {
            const percent = Math.round((allocation.amountCents / total) * 100);
            return (
              <TableRow key={allocation.id}>
                <TableCell className="font-mono text-xs">{allocation.fundId}</TableCell>
                <TableCell className="text-right font-mono tabular-nums">
                  {formatCurrency(allocation.amountCents, locale, donation.currency)}
                </TableCell>
                <TableCell className="text-right text-on-surface-variant">{percent}%</TableCell>
              </TableRow>
            );
          })}
          <TableRow className="font-semibold hover:bg-transparent">
            <TableCell>{t("allocations.total")}</TableCell>
            <TableCell className="text-right font-mono tabular-nums">
              {formatCurrency(donation.amountCents, locale, donation.currency)}
            </TableCell>
            <TableCell className="text-right">100%</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </Card>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 border-b border-outline-variant/50 pb-2 last:border-b-0">
      <dt className="w-40 shrink-0 text-sm font-medium text-on-surface-variant">{label}</dt>
      <dd className="min-w-0 flex-1 text-sm text-on-surface">{children}</dd>
    </div>
  );
}
