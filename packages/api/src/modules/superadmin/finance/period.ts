// #437 — period window resolution for the super-admin finance dashboard.
//
// Centralises every date-fuzz guard so the route handler stays linear:
//   - `custom` requires from + to
//   - `from > to` is a 400
//   - `(to - from) > 366d` is a 400 (DoS guard on the SQL aggregate)
//   - `from < 2024-01-01` clamps silently (platform's first-launch epoch)
//   - all bounds resolve to UTC-midnight so the SQL window matches the
//     dashboard's "what does today look like?" mental model

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

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 366;

function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0),
  );
}

function parseIsoDate(value: string, field: string): Date {
  // TypeBox `format: 'date'` only constrains shape on Fastify's Ajv when
  // ajv-formats is registered. We re-parse defensively here so any
  // request that slipped past validation (or a value Date.parse accepts
  // but is semantically off — `1900-01-01` is the canonical case)
  // fails through the same 400 path.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new PeriodValidationError(`${field} must be an ISO-8601 date (YYYY-MM-DD)`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new PeriodValidationError(`${field} is not a valid date`);
  }
  return parsed;
}

export function resolvePeriod(
  period: "today" | "7d" | "30d" | "90d" | "ytd" | "custom",
  from?: string,
  to?: string,
  now: Date = new Date(),
): ResolvedPeriod {
  const today = startOfUtcDay(now);
  const tomorrow = new Date(today.getTime() + DAY_MS);
  const floor = parseIsoDate(PERIOD_FLOOR_ISO, "floor");

  let rawFrom: Date;
  let rawTo: Date;
  let label: string;

  switch (period) {
    case "today": {
      rawFrom = today;
      rawTo = tomorrow;
      label = "Aujourd'hui";
      break;
    }
    case "7d": {
      rawFrom = new Date(today.getTime() - 7 * DAY_MS);
      rawTo = tomorrow;
      label = "7 derniers jours";
      break;
    }
    case "30d": {
      rawFrom = new Date(today.getTime() - 30 * DAY_MS);
      rawTo = tomorrow;
      label = "30 derniers jours";
      break;
    }
    case "90d": {
      rawFrom = new Date(today.getTime() - 90 * DAY_MS);
      rawTo = tomorrow;
      label = "90 derniers jours";
      break;
    }
    case "ytd": {
      rawFrom = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
      rawTo = tomorrow;
      label = "Depuis le 1ᵉʳ janvier";
      break;
    }
    case "custom": {
      if (!from || !to) {
        throw new PeriodValidationError("Custom period requires both `from` and `to`");
      }
      rawFrom = parseIsoDate(from, "from");
      const inclusiveTo = parseIsoDate(to, "to");
      rawTo = new Date(inclusiveTo.getTime() + DAY_MS);
      label = `${from} → ${to}`;
      break;
    }
    default: {
      throw new PeriodValidationError("Unknown period");
    }
  }

  if (rawFrom.getTime() >= rawTo.getTime()) {
    throw new PeriodValidationError("`from` must be strictly before `to`");
  }

  // Clamp the lower bound to the 2024-01-01 floor BEFORE the span
  // check — a sentinel value like `1900-01-01` should silently snap to
  // the platform's first-launch epoch, not 400 the whole request just
  // because the pre-clamp span is centuries wide.
  let clamped = false;
  let resolvedFrom = rawFrom;
  if (rawFrom.getTime() < floor.getTime()) {
    resolvedFrom = floor;
    clamped = true;
  }

  const rangeDays = Math.round((rawTo.getTime() - resolvedFrom.getTime()) / DAY_MS);
  if (rangeDays > MAX_RANGE_DAYS) {
    throw new PeriodValidationError(
      `Period spans ${rangeDays} days; max allowed is ${MAX_RANGE_DAYS}`,
    );
  }

  const windowMs = rawTo.getTime() - resolvedFrom.getTime();
  const comparisonTo = resolvedFrom;
  const comparisonFrom = new Date(comparisonTo.getTime() - windowMs);

  return {
    from: resolvedFrom,
    to: rawTo,
    label,
    comparisonFrom,
    comparisonTo,
    clamped,
  };
}

export function deltaPercent(current: number, previous: number): number {
  if (previous === 0) {
    return current === 0 ? 0 : 100;
  }
  return ((current - previous) / previous) * 100;
}
