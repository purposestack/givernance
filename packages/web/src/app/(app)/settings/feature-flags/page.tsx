import { AlertTriangle } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { OrgFeatureFlagsList } from "@/components/settings/org-feature-flags-list";
import { SettingsNavigation } from "@/components/settings/settings-navigation";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { createServerApiClient } from "@/lib/api/client-server";
import { FeatureFlagsService, type TenantFlagViewRow } from "@/services/FeatureFlagsService";

export const dynamic = "force-dynamic";

/**
 * Org-admin self-service Feature flags page (Epic #365 / PR #366).
 *
 * SSR-fetches the list of flags this caller is permitted to toggle
 * on their own org. The API server filters to `scope='tenant' AND
 * tenant_override_allowed=true`, so the day-one registry returns
 * zero rows — we render an explanatory empty state.
 */
export default async function OrgFeatureFlagsPage() {
  const t = await getTranslations("settings.featureFlags");
  const api = await createServerApiClient();

  let rows: TenantFlagViewRow[] = [];
  let fetchFailed = false;
  try {
    rows = await FeatureFlagsService.listForOrgAdmin(api);
  } catch {
    fetchFailed = true;
  }

  return (
    <div className="space-y-8">
      <PageHeader title={t("title")} description={t("subtitle")} />
      <SettingsNavigation />

      {/* ADR-035 rule A1 — header + sub-nav are static shell; exactly one
          content block renders below (alert, empty state or flag list), so
          it takes cascade slot 0 (rule A2). */}
      {fetchFailed ? (
        <div
          role="alert"
          className="reveal-item flex items-start gap-3 rounded-2xl border border-error bg-error-container p-4 text-on-error-container"
        >
          <AlertTriangle aria-hidden="true" className="mt-0.5 shrink-0" size={20} />
          <p className="text-sm">{t("fetchFailed")}</p>
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          className="reveal-item"
          title={t("empty.title")}
          description={t("empty.body")}
        />
      ) : (
        <OrgFeatureFlagsList initialRows={rows} />
      )}
    </div>
  );
}
