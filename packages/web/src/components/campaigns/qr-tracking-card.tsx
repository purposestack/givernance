import { QrCode } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency, formatNumber } from "@/lib/format";
import type { CampaignQrStats } from "@/services/PostalCampaignService";

/**
 * Server component — QR-tracking summary widget for the campaign detail page
 * (Epic #274 comment 2). Three numbers: codes generated, codes scanned at
 * least once, and the cleared-donation total reconciled via those scans.
 */
export async function QrTrackingCard({ stats }: { stats: CampaignQrStats }) {
  const t = await getTranslations("campaigns.postal.qrTracking");
  const locale = await getLocale();

  const scanRate =
    stats.totalCodes > 0 ? Math.round((stats.scannedCodes / stats.totalCodes) * 100) : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <QrCode size={18} aria-hidden="true" />
          {t("title")}
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
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
