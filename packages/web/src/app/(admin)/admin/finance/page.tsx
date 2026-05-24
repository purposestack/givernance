/**
 * Super-admin platform finance dashboard (Epic #434 · issue #206).
 *
 * Route: /admin/finance — gated by:
 *   1. `(admin)` layout: requires `super_admin` realm role (else 404).
 *   2. This page: requires `admin.finance_dashboard` feature flag on
 *      (else notFound() — never 403, per feedback_authenticated_unauthorized_uses_404).
 *
 * The page is the i18n boundary: all translated strings are resolved
 * here and passed as `labels` props to the presentational components
 * in `@/components/admin/finance` (which never call `useTranslations`
 * themselves — see #440 head-comment).
 *
 * Data fetching is SSR for the initial render (default period = 30d);
 * period changes after hydration are handled client-side by
 * `FinanceDashboard` via the existing ApiClient.
 */

import { notFound } from "next/navigation";

import { createServerApiClient } from "@/lib/api/client-server";
import { isFinanceDashboardEnabled } from "@/lib/feature-flags/server";
import type { FinanceSummary } from "@/models/superadmin-finance";
import { SuperAdminFinanceService } from "@/services/SuperAdminFinanceService";

import { FinanceDashboard } from "./finance-dashboard";

export const dynamic = "force-dynamic";

export default async function FinancePage() {
  // Flag-gate FIRST — non-flagged probe gets 404 without revealing
  // anything (the super_admin role check has already passed in the
  // layout, but we keep this 404 so off-state QA is uniform).
  if (!(await isFinanceDashboardEnabled())) {
    notFound();
  }

  // i18n (labels) is built inside the client component — the labels
  // shape carries function fields (`foot(count, period)`, `footnote`,
  // `format.shortDate`, …) that RSC cannot serialise across the
  // server→client boundary. The client uses `useTranslations` directly.

  const api = await createServerApiClient();
  let initialSummary: FinanceSummary | null = null;
  let initialError = false;
  try {
    initialSummary = await SuperAdminFinanceService.fetchSummary(api, { period: "30d" });
  } catch {
    // Render-pattern parity with sibling pages: a transient backend
    // failure surfaces as a banner, not a stack trace. The client
    // component handles the empty-state for "no data yet" separately.
    initialError = true;
  }

  return <FinanceDashboard initialSummary={initialSummary} initialError={initialError} />;
}
