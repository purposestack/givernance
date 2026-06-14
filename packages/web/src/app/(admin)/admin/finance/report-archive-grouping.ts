import type { MonthlyReport } from "@/models/superadmin-finance";

export interface ReportYearGroup {
  /** `YYYY` */
  year: string;
  /** Reports for that year, newest month first. */
  items: MonthlyReport[];
}

/**
 * Group monthly reports by calendar year for the sectioned archive list.
 *
 * The API returns rows ordered `month DESC`, but we sort a copy defensively
 * by the `YYYY-MM` string (descending — `localeCompare` is exact for the
 * zero-padded `YYYY-MM` shape) before bucketing, so a year can never render
 * as two separate bands if the upstream order ever drifts. Bucketing is then
 * a single linear pass; years come out descending and months stay descending
 * within each. The `YYYY` prefix split avoids any timezone / Date parsing.
 */
export function groupReportsByYear(reports: MonthlyReport[]): ReportYearGroup[] {
  const sorted = [...reports].sort((a, b) => b.month.localeCompare(a.month));
  const groups: ReportYearGroup[] = [];
  for (const report of sorted) {
    const year = report.month.slice(0, 4);
    const last = groups.at(-1);
    if (last && last.year === year) {
      last.items.push(report);
    } else {
      groups.push({ year, items: [report] });
    }
  }
  return groups;
}
