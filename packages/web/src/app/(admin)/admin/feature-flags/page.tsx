import { AlertTriangle } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { FeatureFlagsTable } from "@/components/admin/feature-flags-table";
import { createServerApiClient } from "@/lib/api/client-server";
import { type FeatureFlagRow, FeatureFlagsService } from "@/services/FeatureFlagsService";

export const dynamic = "force-dynamic";

/**
 * Super-admin-only Back Office page: global feature-flag registry
 * (PR #352 follow-up; the bulk-email feature gated by
 * `communication.bulk_email` is the first consumer, disabled by
 * default until DKIM/SPF land — see `docs/23 § 6.bis` for the
 * rationale).
 *
 * SSR pattern matches `admin/platform-admins/page.tsx`: fetch the
 * full registry once on the server, render through a client
 * component that owns the toggle interaction + optimistic updates.
 */
export default async function FeatureFlagsPage() {
  const t = await getTranslations("admin.featureFlags");
  const api = await createServerApiClient();

  let rows: FeatureFlagRow[] = [];
  let fetchFailed = false;
  try {
    rows = await FeatureFlagsService.list(api);
  } catch {
    // Same posture as platform-admins/page.tsx — render a banner, not
    // a misleading "no flags yet" empty state.
    fetchFailed = true;
  }

  return (
    <div className="space-y-8">
      {/* ADR-035 rule A1 — the page header is static shell; the content
          below (banner or flag list) enters as one block at slot 0
          (container-level reveal, no per-row choreography). */}
      <header>
        <h1 className="font-heading text-2xl text-on-surface">{t("title")}</h1>
        <p className="mt-1 text-sm text-on-surface-variant">{t("subtitle")}</p>
      </header>

      <div className="reveal-item">
        {fetchFailed ? (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-2xl border border-error bg-error-container p-4 text-on-error-container"
          >
            <AlertTriangle aria-hidden="true" className="mt-0.5 shrink-0" size={20} />
            <p className="text-sm">{t("fetchFailed")}</p>
          </div>
        ) : (
          <FeatureFlagsTable rows={rows} />
        )}
      </div>
    </div>
  );
}
