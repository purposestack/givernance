import { AlertTriangle } from "lucide-react";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { PerFlagTenants } from "@/components/admin/per-flag-tenants";
import { createServerApiClient } from "@/lib/api/client-server";
import {
  type FeatureFlagRow,
  FeatureFlagsService,
  type FlagTenantRow,
} from "@/services/FeatureFlagsService";

export const dynamic = "force-dynamic";

/**
 * Super-admin per-flag tenant management page (Epic #365 / PR #366
 * follow-up after reviewer feedback). Click-through destination from
 * `/admin/feature-flags` — lets the operator manage "5 enabled across
 * 45 tenants" without navigating the per-tenant detail page 45 times.
 *
 * 404s when the flag key is unknown — that's a hand-typed URL, not a
 * navigable mistake.
 */
export default async function PerFlagTenantsPage({ params }: { params: Promise<{ key: string }> }) {
  const t = await getTranslations("admin.featureFlags.perFlagTenants");
  const { key } = await params;

  const api = await createServerApiClient();

  // Fetch the flag's metadata + the tenant listing in parallel. If
  // either fetch fails we render the error banner rather than a
  // half-populated page.
  let flag: FeatureFlagRow | null = null;
  let tenants: FlagTenantRow[] = [];
  let fetchFailed = false;
  try {
    const [list, perFlagTenants] = await Promise.all([
      FeatureFlagsService.list(api),
      FeatureFlagsService.listTenantsForFlag(api, key),
    ]);
    flag = list.find((row) => row.key === key) ?? null;
    tenants = perFlagTenants;
  } catch {
    fetchFailed = true;
  }

  if (!fetchFailed && !flag) {
    // Unknown flag key — anti-disclosure 404.
    notFound();
  }

  return (
    <div className="space-y-6">
      {/* ADR-035 rule A1 — the back link is static shell; the content
          below (banner or per-flag manager) enters as one block at slot 0
          (container-level reveal only). */}
      <a href="/admin/feature-flags" className="text-xs text-primary hover:underline">
        {t("backToList")}
      </a>

      <div className="reveal-item">
        {fetchFailed || !flag ? (
          <div
            role="alert"
            className="flex items-start gap-3 rounded-2xl border border-error bg-error-container p-4 text-on-error-container"
          >
            <AlertTriangle aria-hidden="true" className="mt-0.5 shrink-0" size={20} />
            <p className="text-sm">{t("fetchFailed")}</p>
          </div>
        ) : (
          <PerFlagTenants flag={flag} initialTenants={tenants} />
        )}
      </div>
    </div>
  );
}
