// Mirror of packages/api/src/modules/superadmin/finance/period.ts.
// Copied here so the worker's cron-trigger processor can build a
// ResolvedPeriod without importing across package boundaries.
// Keep in sync with the API original when the period logic changes.

export const PERIOD_FLOOR_ISO = "2024-01-01";

export class PeriodValidationError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(detail);
    this.name = "PeriodValidationError";
    this.detail = detail;
  }
}

export interface ResolvedPeriod {
  /** Inclusive lower bound (UTC midnight). */
  from: Date;
  /** Exclusive upper bound (UTC midnight, day after the last day of the window). */
  to: Date;
  /** Human-readable label used by the UI ("Aujourd'hui", "30 derniers jours", …). */
  label: string;
  /** Equal-length previous window for deltas. */
  comparisonFrom: Date;
  comparisonTo: Date;
  /** True when the lower bound was clamped to the 2024-01-01 platform floor. */
  clamped: boolean;
}

export function deltaPercent(current: number, previous: number): number {
  if (previous === 0) {
    return current === 0 ? 0 : 100;
  }
  return ((current - previous) / previous) * 100;
}
