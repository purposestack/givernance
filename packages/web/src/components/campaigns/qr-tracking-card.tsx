import { Banknote, QrCode } from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency, formatDate, formatNumber } from "@/lib/format";
import type { CampaignQrStats, CampaignSwissRailStats } from "@/services/PostalCampaignService";

/**
 * Server component — QR-tracking summary widget for the campaign detail
 * page (Epic #274 + Epic #318 PR #5 extension).
 *
 * Renders three variants based on the merged stats shape (docs/25 §5.3):
 *   - **Mixed** — Stripe rail active (`qrAttributedDonations > 0` or any
 *     scanned-not-paid signal) AND `swissRail` set → both lines visible.
 *   - **Pure-Swiss** — `swissRail` set, Stripe rail effectively idle
 *     (`qrAttributedDonations === 0` AND no scanned-not-paid) → Stripe
 *     line collapsed.
 *   - **Door-drop** — `pendingQrBills === null` on the swissRail block.
 *     Scan stage omitted (`scannedCodes === 0` is structurally absent,
 *     not "0 scans observed").
 */
export async function QrTrackingCard({ stats }: { stats: CampaignQrStats }) {
  const t = await getTranslations("campaigns.postal.qrTracking");
  const locale = await getLocale();

  const swiss = stats.swissRail;
  const isSwiss = swiss !== null;
  const isDoorDrop = isSwiss && swiss.pendingQrBills === null;
  // Stripe rail counts as "active" if any donation came through it OR
  // any scan was recorded — once either signal is present the operator
  // benefits from seeing it on the funnel.
  const stripeRailActive = stats.qrAttributedDonations > 0 || stats.scannedCodes > 0;

  // Currency for the Swiss-rail amount block. CHF is the canonical
  // QR-bill currency (EUR + QRR is illegal per IG QR-bill v2.4). The
  // backend stores raw cents in the amountCents column — we pass CHF
  // as the formatter currency so the Intl output renders correctly.
  const swissCurrency = "CHF";

  const scanRate =
    stats.totalCodes > 0 ? Math.round((stats.scannedCodes / stats.totalCodes) * 100) : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <QrCode size={18} aria-hidden="true" />
          {t("title")}
          {isSwiss ? (
            <Badge variant="success" className="ml-1">
              <Banknote size={10} className="mr-1" aria-hidden="true" />
              {t("swissRail.badge")}
            </Badge>
          ) : null}
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>

      {/* Standard French rail (no Swiss-bill linked) — keep the original
          3-column metric block to avoid regressing existing campaigns. */}
      {!isSwiss ? (
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <Metric
            label={t("metrics.totalCodes")}
            value={formatNumber(stats.totalCodes, locale)}
            hint={t("metrics.totalCodesHint")}
          />
          <Metric
            label={t("metrics.scannedCodes")}
            value={`${formatNumber(stats.scannedCodes, locale)} (${scanRate}%)`}
            hint={t("metrics.scannedCodesHint")}
          />
          <Metric
            label={t("metrics.attributedAmount")}
            value={formatCurrency(stats.qrAttributedAmountCents, locale)}
            hint={t("metrics.attributedAmountHint", {
              count: stats.qrAttributedDonations,
            })}
          />
        </CardContent>
      ) : (
        <CardContent className="space-y-4">
          {/* Funnel — printed → (scanned →) paid → remarketing/pending */}
          <FunnelRow
            num={isDoorDrop ? swiss.totalQrBills : stats.totalCodes}
            locale={locale}
            label={isDoorDrop ? t("swissRail.distributed") : t("swissRail.printed")}
            sub={isDoorDrop ? t("swissRail.distributedHint") : t("swissRail.printedHint")}
          />

          {/* Scan stage — omitted on door-drop (no per-letter QR signal). */}
          {!isDoorDrop ? (
            <FunnelRow
              num={stats.scannedCodes}
              locale={locale}
              label={`${t("swissRail.scanned")} (${scanRate}%)`}
              sub={t("swissRail.scannedHint")}
            />
          ) : null}

          {/* Stripe-rail paid (only when the rail is active). */}
          {stripeRailActive ? (
            <BranchRow
              num={stats.qrAttributedDonations}
              locale={locale}
              connector="├─→"
              amount={formatCurrency(stats.qrAttributedAmountCents, locale)}
              label={t("swissRail.paidViaStripe")}
              tagLabel={t("swissRail.tagStripe")}
              tagTone="info"
            />
          ) : null}

          {/* Swiss QR-bill paid — always rendered when isSwiss. */}
          <BranchRow
            num={swiss.paidQrBills}
            locale={locale}
            connector="├─→"
            amount={formatCurrency(swiss.paidQrBillAmountCents, locale, swissCurrency)}
            label={isDoorDrop ? t("swissRail.paidDoorDrop") : t("swissRail.paidViaQrBill")}
            tagLabel={t("swissRail.tagSwiss")}
            tagTone="success"
          />

          {/* Scanned-not-paid remarketing cohort (only personalised + scan-tracked) */}
          {!isDoorDrop && stats.scannedCodes > stats.qrAttributedDonations ? (
            <BranchRow
              num={
                stats.scannedCodes -
                stats.qrAttributedDonations -
                Math.min(stats.scannedCodes, swiss.paidQrBills)
              }
              locale={locale}
              connector="└─→"
              label={t("swissRail.scannedNotPaid")}
              tagLabel={t("swissRail.tagRemarket")}
              tagTone="warning"
            />
          ) : null}

          {/* Partial-match badge — only when the printed amount differed
              from the paid amount on at least one entry. */}
          {swiss.partialMatchCount > 0 ? (
            <div className="rounded-md bg-warning/10 px-3 py-2 text-xs text-on-surface">
              <Badge variant="warning" className="mr-2">
                {t("swissRail.partialMatchBadge")}
              </Badge>
              {t("swissRail.partialMatchBody", { count: swiss.partialMatchCount })}
            </div>
          ) : null}

          {/* Footer — pending camt review + last statement import */}
          <FooterMetrics
            stats={swiss}
            locale={locale}
            // `swissRail` doesn't carry the bankAccountId — operators
            // wanting to filter the unreconciled queue by campaign use
            // the generic queue page and pick a bank account.
            unreconciledHref="/settings/camt-unreconciled"
          />
        </CardContent>
      )}
    </Card>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-xl bg-surface-container p-4">
      <p className="text-sm text-on-surface-variant">{label}</p>
      <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-on-surface">{value}</p>
      <p className="mt-1 text-xs text-on-surface-variant">{hint}</p>
    </div>
  );
}

function FunnelRow({
  num,
  locale,
  label,
  sub,
}: {
  num: number;
  locale: string;
  label: string;
  sub: string;
}) {
  return (
    <div className="grid grid-cols-[80px_1fr] items-center gap-3 border-b border-dashed border-outline-variant pb-3 last:border-b-0 last:pb-0">
      <span className="text-right font-heading text-3xl leading-none text-on-surface">
        {formatNumber(num, locale)}
      </span>
      <span className="text-sm">
        <span className="font-medium text-on-surface">{label}</span>
        <span className="block text-xs text-on-surface-variant">{sub}</span>
      </span>
    </div>
  );
}

function BranchRow({
  num,
  locale,
  connector,
  amount,
  label,
  tagLabel,
  tagTone,
}: {
  num: number;
  locale: string;
  connector: string;
  amount?: string;
  label: string;
  tagLabel: string;
  tagTone: "info" | "success" | "warning";
}) {
  return (
    <div className="grid grid-cols-[80px_24px_1fr] items-center gap-2 py-1.5 pl-4">
      <span className="text-right font-mono text-base text-on-surface">
        {formatNumber(num, locale)}
      </span>
      <span className="text-center font-mono text-lg text-on-surface-variant">{connector}</span>
      <span className="flex flex-wrap items-center gap-2 text-xs text-on-surface-variant">
        {amount ? <span className="font-mono font-medium text-on-surface">{amount}</span> : null}
        <span>{label}</span>
        <Badge variant={tagTone}>{tagLabel}</Badge>
      </span>
    </div>
  );
}

function FooterMetrics({
  stats,
  locale,
  unreconciledHref,
}: {
  stats: CampaignSwissRailStats;
  locale: string;
  unreconciledHref: string;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 border-t border-outline-variant pt-3 sm:grid-cols-2">
      <UnreconciledBlock count={stats.unreconciledCount} href={unreconciledHref} />
      <LastImportBlock value={stats.lastStatementImportedAt} locale={locale} />
    </div>
  );
}

async function UnreconciledBlock({ count, href }: { count: number; href: string }) {
  const t = await getTranslations("campaigns.postal.qrTracking.swissRail.footer");
  return (
    <div>
      <p className="text-xs text-on-surface-variant">{t("pendingLabel")}</p>
      {count > 0 ? (
        <Link
          href={href}
          className="mt-1 inline-block font-mono text-sm font-semibold text-warning hover:underline"
        >
          {t("pendingValue", { count })}
        </Link>
      ) : (
        <p className="mt-1 font-mono text-sm text-on-surface-variant">{t("pendingValueZero")}</p>
      )}
    </div>
  );
}

async function LastImportBlock({ value, locale }: { value: string | null; locale: string }) {
  const t = await getTranslations("campaigns.postal.qrTracking.swissRail.footer");
  return (
    <div>
      <p className="text-xs text-on-surface-variant">{t("lastImportLabel")}</p>
      <p className="mt-1 font-mono text-sm text-on-surface">
        {value ? formatDate(value, locale, "medium") : t("lastImportNever")}
      </p>
    </div>
  );
}
