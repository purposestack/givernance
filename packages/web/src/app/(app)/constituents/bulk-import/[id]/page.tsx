import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { BulkImportResults } from "@/components/constituents/bulk-import-results";
import { PageHeader } from "@/components/shared/page-header";
import { createServerApiClient } from "@/lib/api/client-server";
import { requirePermission } from "@/lib/auth/guards";
import { FeatureFlagsService, isFlagEnabled } from "@/services/FeatureFlagsService";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function BulkImportResultsPage({ params }: PageProps) {
  await requirePermission("write");
  const { id } = await params;
  const tResults = await getTranslations("constituents.bulkImport.results");
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
  if (!enabled) notFound();

  return (
    <>
      <PageHeader
        title={tResults("title")}
        breadcrumbs={[
          { label: tConstituents("breadcrumbRoot"), href: "/dashboard" },
          { label: tConstituents("title"), href: "/constituents" },
          { label: tHistory("breadcrumb"), href: "/constituents/bulk-import" },
          { label: id.slice(0, 8) },
        ]}
      />
      <BulkImportResults jobId={id} />
    </>
  );
}
