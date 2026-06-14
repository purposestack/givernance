/**
 * Super-admin platform finance dashboard (Epic #434 · issue #206).
 *
 * Route: /admin/finance — gated by the `(admin)` layout, which requires
 * the `super_admin` realm role (else 404).
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

import { createServerApiClient } from "@/lib/api/client-server";
import type { FinanceSummary } from "@/models/superadmin-finance";
import { SuperAdminFinanceService } from "@/services/SuperAdminFinanceService";

import { FinanceDashboard } from "./finance-dashboard";

export const dynamic = "force-dynamic";

export default async function FinancePage() {
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
