// #437 — period window resolution for the super-admin finance dashboard.
//
// Thin re-export shim (issue #443): the implementation now lives in the
// shared `@givernance/shared/finance/reporting` module so the API and
// the worker share one copy. `period.ts` is pure (no `db`), so this is
// a straight re-export of the period symbols — kept explicit (rather
// than `export *`) to avoid leaking the rest of the reporting surface
// through this path.

export {
  deltaPercent,
  PERIOD_FLOOR_ISO,
  PeriodValidationError,
  type ResolvedPeriod,
  resolvePeriod,
} from "@givernance/shared/finance/reporting";
