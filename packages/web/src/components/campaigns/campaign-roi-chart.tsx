import { useId } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency, formatPercent } from "@/lib/format";

interface CampaignRoiChartLabels {
  title: string;
  subtitle: string;
  cost: string;
  raised: string;
  roi: string;
  metric: string;
  amount: string;
  unavailable: string;
  tableCaption: string;
  chartSummary: string;
  chartSummaryUnavailable: string;
}

interface CampaignRoiChartProps {
  costCents: number | null;
  totalRaisedCents: number;
  roi: number | null;
  locale: string;
  labels: CampaignRoiChartLabels;
}

interface SeriesItem {
  key: "cost" | "raised";
  label: string;
  value: number;
  displayValue: string;
  barClassName: string;
  /**
   * ADR-035 rule A8 — a not-yet-computed value (cost unavailable) renders
   * as a hatched texture inside the track, never a blank bar. A real zero
   * keeps the plain empty track.
   */
  unavailable: boolean;
}

export function CampaignRoiChart({
  costCents,
  totalRaisedCents,
  roi,
  locale,
  labels,
}: CampaignRoiChartProps) {
  const id = useId();
  const figureCaptionId = `${id}-summary`;
  const tableId = `${id}-table`;
  const tableCaptionId = `${id}-table-caption`;
  const chartMax = Math.max(costCents ?? 0, totalRaisedCents, 1);
  const costDisplayValue =
    costCents !== null ? formatCurrency(costCents, locale) : labels.unavailable;
  const raisedDisplayValue = formatCurrency(totalRaisedCents, locale);
  const roiDisplayValue = roi !== null ? formatPercent(roi, locale, 1) : labels.unavailable;
  const summary = roi !== null ? labels.chartSummary : labels.chartSummaryUnavailable;

  const series: SeriesItem[] = [
    {
      key: "cost",
      label: labels.cost,
      value: costCents ?? 0,
      displayValue: costDisplayValue,
      barClassName: "bg-amber",
      unavailable: costCents === null,
    },
    {
      key: "raised",
      label: labels.raised,
      value: totalRaisedCents,
      displayValue: raisedDisplayValue,
      barClassName: "bg-primary",
      unavailable: false,
    },
  ];

  return (
    <Card>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <CardHeader className="gap-1">
          <CardTitle>{labels.title}</CardTitle>
          <CardDescription>{labels.subtitle}</CardDescription>
        </CardHeader>
        <div className="w-full rounded-xl bg-surface-container px-4 py-3 sm:max-w-44 lg:w-auto">
          <p className="text-xs font-medium uppercase tracking-wide text-on-surface-variant">
            {labels.roi}
          </p>
          <p
            className={`mt-1 font-mono text-2xl font-semibold tabular-nums ${
              roi === null ? "text-on-surface" : roi >= 0 ? "text-success-text" : "text-error-text"
            }`}
          >
            {roiDisplayValue}
          </p>
        </div>
      </div>

      {/* ADR-035 rule A7 — labels + values appear with the card; only the
          BARS draw left→right once per mount via the shared .sweep-in
          clip-path utility on each track (delay auto-chains from the
          card's inherited --cascade-i slot). Server component: it only
          re-renders through RSC reconciliation (DOM nodes persist), so
          background refetches never replay the sweep (rule B12). */}
      <figure className="mt-5 space-y-4" aria-describedby={figureCaptionId} aria-details={tableId}>
        {series.map((item) => {
          const width = Math.max((item.value / chartMax) * 100, item.value > 0 ? 8 : 0);
          return (
            <CardContent
              key={item.key}
              className="mt-0 rounded-xl border border-outline-variant/60 bg-surface-container-low p-4"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <span className="text-sm font-medium text-on-surface">{item.label}</span>
                <span className="font-mono text-sm tabular-nums text-on-surface-variant">
                  {item.displayValue}
                </span>
              </div>
              <div
                className="sweep-in mt-3 h-3 overflow-hidden rounded-pill bg-surface-container-highest"
                aria-hidden="true"
              >
                {item.unavailable ? (
                  // Rule A8 — diagonal hatching says "no data here" instead
                  // of a blank track (the sr-only table + displayValue carry
                  // the "unavailable" copy for assistive tech).
                  <div className="h-full rounded-pill bg-[repeating-linear-gradient(-45deg,transparent,transparent_4px,var(--color-outline-variant)_4px,var(--color-outline-variant)_6px)]" />
                ) : (
                  <div
                    className={`h-full rounded-pill ${item.barClassName}`}
                    style={{ width: `${Math.min(width, 100)}%` }}
                  />
                )}
              </div>
            </CardContent>
          );
        })}
        <figcaption id={figureCaptionId} className="sr-only">
          {summary}
        </figcaption>
      </figure>

      <table
        id={tableId}
        aria-labelledby={`${figureCaptionId} ${tableCaptionId}`}
        className="sr-only"
      >
        <caption id={tableCaptionId}>{labels.tableCaption}</caption>
        <thead>
          <tr>
            <th scope="col">{labels.metric}</th>
            <th scope="col">{labels.amount}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">{labels.cost}</th>
            <td>{costDisplayValue}</td>
          </tr>
          <tr>
            <th scope="row">{labels.raised}</th>
            <td>{raisedDisplayValue}</td>
          </tr>
          <tr>
            <th scope="row">{labels.roi}</th>
            <td>{roiDisplayValue}</td>
          </tr>
        </tbody>
      </table>
    </Card>
  );
}
