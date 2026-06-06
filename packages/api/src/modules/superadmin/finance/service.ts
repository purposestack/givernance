// #437 — super-admin platform finance summary aggregation.
//
// Thin shim (issue #443): the implementation now lives in the shared
// `@givernance/shared/finance/reporting` module so the API (manual
// report + dashboard) and the worker (monthly cron) build the SAME
// snapshot from one copy. `buildFinanceSummary` is dependency-injected
// with a `db` handle in shared; here we pre-bind the API's `systemDb`
// (owner pool — the read is platform-wide) so every existing call site
// keeps its current `buildFinanceSummary(input)` signature.

import {
  type SummaryInput,
  type SummaryServiceResult,
  buildFinanceSummary as sharedBuildFinanceSummary,
} from "@givernance/shared/finance/reporting";
import { systemDb } from "../../../lib/db.js";

export function buildFinanceSummary(input: SummaryInput): Promise<SummaryServiceResult> {
  return sharedBuildFinanceSummary(systemDb, input);
}

export type {
  SummaryFilters,
  SummaryInput,
  SummaryServiceResult,
} from "@givernance/shared/finance/reporting";
