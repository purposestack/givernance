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
  locale: string;
  labels: CampaignRoiChartLabels;
}

interface SeriesItem {
  key: "cost" | "raised";
  label: string;
  value: number;
  displayValue: string;
  barClassName: string;
}

export function CampaignRoiChart({
  costCents,
  totalRaisedCents,
  locale,
  labels,
}: CampaignRoiChartProps) {
  const roi =
    costCents && costCents > 0 ? ((totalRaisedCents - costCents) / costCents) * 100 : null;
  const chartMax = Math.max(costCents ?? 0, totalRaisedCents, 1);
  const costDisplayValue =
    costCents !== null ? formatCurrency(costCents, locale) : labels.unavailable;
  const raisedDisplayValue = formatCurrency(totalRaisedCents, locale);
  const roiDisplayValue = roi !== null ? formatPercent(roi, locale, 1) : labels.unavailable;
  const summary =
    roi !== null
      ? labels.chartSummary
          .replace("{raised}", raisedDisplayValue)
          .replace("{cost}", costDisplayValue)
          .replace("{roi}", roiDisplayValue)
      : labels.chartSummaryUnavailable
          .replace("{raised}", raisedDisplayValue)
          .replace("{cost}", costDisplayValue);

  const series: SeriesItem[] = [
    {
      key: "cost",
      label: labels.cost,
      value: costCents ?? 0,
      displayValue: costDisplayValue,
      barClassName: "bg-amber",
    },
    {
      key: "raised",
      label: labels.raised,
      value: totalRaisedCents,
      displayValue: raisedDisplayValue,
      barClassName: "bg-primary",
    },
  ];

  return (
    <section className="rounded-2xl bg-surface-container-lowest p-6 shadow-card">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="font-heading text-xl text-on-surface">{labels.title}</h2>
          <p className="mt-1 text-sm text-on-surface-variant">{labels.subtitle}</p>
        </div>
        <div className="rounded-xl bg-surface-container px-4 py-3 sm:min-w-36">
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

      <div className="mt-6 space-y-4" aria-describedby="campaign-roi-summary">
        {series.map((item) => {
          const width = Math.max((item.value / chartMax) * 100, item.value > 0 ? 6 : 0);
          return (
            <div key={item.key} className="space-y-2">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm font-medium text-on-surface">{item.label}</span>
                <span className="font-mono text-sm tabular-nums text-on-surface-variant">
                  {item.displayValue}
                </span>
              </div>
              <div
                className="h-4 overflow-hidden rounded-full bg-surface-container"
                aria-hidden="true"
              >
                <div
                  className={`h-full rounded-full ${item.barClassName}`}
                  style={{ width: `${Math.min(width, 100)}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>

      <p id="campaign-roi-summary" className="sr-only">
        {summary}
      </p>

      <table className="sr-only">
        <caption>{labels.tableCaption}</caption>
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
    </section>
  );
}
