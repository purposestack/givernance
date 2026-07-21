import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import type { CustomFieldValues } from "@givernance/shared/custom-fields";
import { ArrowLeft, Pencil } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";

import { DeleteDonationButton } from "@/components/donations/delete-donation-button";
import { ReceiptPreviewButton } from "@/components/donations/receipt-preview-button";
import { RefundDonationButton } from "@/components/donations/refund-donation-button";
import {
  CustomFieldDetailRows,
  type DetailRowDefinition,
  fetchCustomFieldDefinitionsOrEmpty,
  fetchDetailCustomFieldDefinitionsOrEmpty,
  projectableDefinitions,
  visibleDetailCustomFieldDefinitions,
} from "@/components/shared/custom-fields";
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
import { hasPermission, requireAuth } from "@/lib/auth/guards";
import { formatCurrency, formatDate } from "@/lib/format";
import type { DonationAllocation, DonationDetail } from "@/models/donation";
import { donationDetailDonorName } from "@/models/donation";
import { DonationService } from "@/services/DonationService";
import { FeatureFlagsService, isFlagEnabled } from "@/services/FeatureFlagsService";

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
  const auth = await requireAuth();
  const canWrite = hasPermission(auth, "write");
  const canDelete = hasPermission(auth, "admin");
  const { id } = await params;
  const donation = await fetchDonationOrNotFound(id);

  // Epic #539 — donation-domain fields on this donation + the donor's
  // projected fields (donorCustom, §6). Flag off / fetch failure ⇒ no defs ⇒
  // both groups completely absent.
  let donationCustomEnabled = false;
  let constituentCustomEnabled = false;
  const client = await createServerApiClient();
  try {
    const flags = await FeatureFlagsService.listPublic(client);
    donationCustomEnabled = isFlagEnabled(flags, FEATURE_FLAG_KEYS.DONATIONS_CUSTOM_FIELDS);
    constituentCustomEnabled = isFlagEnabled(flags, FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS);
  } catch {
    donationCustomEnabled = false;
    constituentCustomEnabled = false;
  }
  // Donation-domain fields use the detail catalog (includeArchived) so
  // archived definitions' stored values stay visible on this page; the
  // constituent catalog stays active-only — archived fields leave the
  // donorCustom projection entirely (archive contract).
  const [donationDefs, constituentDefs] = await Promise.all([
    fetchDetailCustomFieldDefinitionsOrEmpty(client, "donation", donationCustomEnabled),
    fetchCustomFieldDefinitionsOrEmpty(client, "constituent", constituentCustomEnabled),
  ]);
  // Server re-enforces eligibility per request; this filter only picks which
  // rows the UI renders.
  const donorDefs = projectableDefinitions(constituentDefs);

  const [t, tDonations, tCustom, locale] = await Promise.all([
    getTranslations("donations.detail"),
    getTranslations("donations"),
    getTranslations("customFields"),
    getLocale(),
  ]);

  const donorName = donationDetailDonorName(donation) || t("anonymousDonor");
  const amountLabel = formatCurrency(donation.amountCents, locale, donation.currency);
  // Refund button visible only when:
  //   - the operator is an org_admin (`canDelete` proxies for "admin"),
  //   - the donation came in via Stripe (only path our refund route supports),
  //   - the donation isn't already refunded (avoids 422 on click).
  // Off-Stripe donations (cash/SEPA/check) need their own refund flow,
  // tracked separately — guarding by `paymentMethod` keeps this scoped
  // to issue #199's contract without breaking other payment methods.
  const canRefund =
    canDelete && donation.paymentMethod === "stripe" && donation.status !== "refunded";

  // ADR-035 rule A2 — entrance cascade in reading order: header + its
  // action row (receipt / refund / delete) reveal first, then the content
  // cards stagger in via `.cascade`. Server-rendered classes only; a
  // router.refresh after refund/delete reconciles the same DOM nodes, so
  // the choreography never replays on a data refresh (rule B12).
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
            {canWrite ? (
              <Button asChild size="sm">
                <Link href={`/donations/${donation.id}/edit`}>
                  <Pencil size={16} aria-hidden="true" />
                  {t("actions.edit")}
                </Link>
              </Button>
            ) : null}
            <ReceiptPreviewButton donationId={donation.id} />
            {canRefund ? (
              <RefundDonationButton
                donationId={donation.id}
                amountLabel={amountLabel}
                donorName={donationDetailDonorName(donation) || null}
              />
            ) : null}
            {canDelete ? (
              <DeleteDonationButton
                donationId={donation.id}
                donorName={donationDetailDonorName(donation) || null}
              />
            ) : null}
          </>
        }
      />

      <div className="cascade grid gap-6 md:grid-cols-2">
        <InfoCard
          donation={donation}
          donorName={donorName}
          amountLabel={amountLabel}
          locale={locale}
        />
        <AllocationsCard donation={donation} allocations={donation.allocations} locale={locale} />
        {/* Epic #539 — donation-domain custom fields; absent when flag off / no defs. */}
        <CustomFieldsCard
          title={tCustom("detail.sectionTitle")}
          definitions={donationDefs}
          values={donation.custom}
          locale={locale}
          booleanLabels={{ yes: tCustom("boolean.yes"), no: tCustom("boolean.no") }}
          archivedLabel={tCustom("detail.archivedBadge")}
        />
        {/* Epic #539 §6 — the donor's projected (showOnRelated ∧ ¬sensitive)
            fields. Values come from the API's per-request serializer
            (donorCustom); an erased donor projects nothing. */}
        <CustomFieldsCard
          title={tCustom("detail.donorSectionTitle")}
          definitions={donorDefs}
          values={donation.donorCustom}
          locale={locale}
          booleanLabels={{ yes: tCustom("boolean.yes"), no: tCustom("boolean.no") }}
        />
      </div>
    </>
  );
}

function CustomFieldsCard({
  title,
  definitions,
  values,
  locale,
  booleanLabels,
  archivedLabel,
}: {
  title: string;
  definitions: DetailRowDefinition[];
  values: CustomFieldValues | undefined;
  locale: string;
  booleanLabels: { yes: string; no: string };
  /** Provided when the catalog may carry archived definitions. */
  archivedLabel?: string;
}) {
  // Active defs always render (em-dash when empty); archived defs only
  // when this record still holds a value.
  const visible = visibleDetailCustomFieldDefinitions(definitions, values);
  if (visible.length === 0) return null;
  return (
    <Card className="p-6">
      <h2 className="mb-4 font-heading text-xl text-on-surface">{title}</h2>
      <CustomFieldDetailRows
        definitions={visible}
        values={values}
        locale={locale}
        booleanLabels={booleanLabels}
        archivedLabel={archivedLabel}
      />
    </Card>
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
        <DetailRow label={t("fields.fiscalYear")}>
          {donation.fiscalYear ? String(donation.fiscalYear) : t("notRecorded")}
        </DetailRow>
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
                <TableCell>{allocation.fundName || allocation.fundId}</TableCell>
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
