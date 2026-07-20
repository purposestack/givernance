import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { BulkImportHistory } from "@/components/constituents/bulk-import-history";
import { PageHeader } from "@/components/shared/page-header";
import { createServerApiClient } from "@/lib/api/client-server";
import { requirePermission } from "@/lib/auth/guards";
import { FeatureFlagsService, isFlagEnabled } from "@/services/FeatureFlagsService";

export default async function BulkImportHistoryPage() {
  await requirePermission("write");
  const tHistory = await getTranslations("constituents.bulkImport.history");
  const tConstituents = await getTranslations("constituents");

  const client = await createServerApiClient();
  let enabled = false;
  try {
    const flags = await FeatureFlagsService.listPublic(client);
    enabled = isFlagEnabled(flags, FEATURE_FLAG_KEYS.CONSTITUENTS_BULK_IMPORT);
  } catch {
    enabled = false;
  }

  if (!enabled) {
    notFound();
  }

  return (
    <>
      <PageHeader
        title={tHistory("title")}
        description={tHistory("subtitle")}
        breadcrumbs={[
          { label: tConstituents("breadcrumbRoot"), href: "/dashboard" },
          { label: tConstituents("title"), href: "/constituents" },
          { label: tHistory("breadcrumb") },
        ]}
      />
      {/* ADR-035 rules A1 + A2 — header static; the history table is the
          only content block, so it takes slot 0. The wrapper mounts once
          with the page and covers every body state (ghost rows → table /
          error / empty), so the loading→data swap inside never replays
          the entrance (rule B12). Hand-rolled table → container-level
          treatment only, no per-row cascade. */}
      <div className="reveal-item">
        <BulkImportHistory />
      </div>
    </>
  );
}
