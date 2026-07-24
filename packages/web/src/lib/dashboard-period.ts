/**
 * Dashboard KPI period helpers (issue #229).
 *
 * The bounds MUST mirror the API's `monthRanges()` in
 * `packages/api/src/modules/dashboard/service.ts` — calendar month, UTC,
 * half-open `[monthStart, nextMonthStart)` — so the period labels and the
 * donations deep link agree with the aggregated figures. Extracted from the
 * dashboard server component so the rollover math is unit-testable.
 */
export interface MonthBoundsUtc {
  /** First instant of the current UTC calendar month. */
  monthStart: Date;
  /** Last calendar day of the current UTC month (00:00 UTC). */
  monthLastDay: Date;
}

export function monthBoundsUtc(now: Date): MonthBoundsUtc {
  return {
    monthStart: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    // Day 0 of next month = last day of this month (handles Dec→Jan and leap
    // February without special cases).
    monthLastDay: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)),
  };
}

/** `YYYY-MM-DD` (UTC) — the shape the donations list `dateFrom`/`dateTo` accept. */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
