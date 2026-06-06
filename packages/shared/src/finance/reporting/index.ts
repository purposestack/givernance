// Shared finance-reporting module (issue #443).
//
// One implementation of the super-admin finance aggregation +
// monthly-report orchestration, dependency-injected with a Drizzle
// handle (and, for the report flow, an enqueue closure) so the API
// (manual report + dashboard) and the worker (monthly cron + boot
// backfill) build the SAME snapshot and drive the SAME idempotent
// request flow — no duplication, no drift.
//
// Reachable ONLY via the `@givernance/shared/finance/reporting`
// subpath — deliberately NOT re-exported from the root barrel
// (`src/index.ts`) nor `src/finance/index.ts`, which reach the web
// package. Keeping the Drizzle-query code out of the root barrel
// avoids an ADR-013 frontend-boundary leak.

export * from "./mobilisation.js";
export * from "./monthly-report.js";
export * from "./period.js";
export * from "./summary.js";
