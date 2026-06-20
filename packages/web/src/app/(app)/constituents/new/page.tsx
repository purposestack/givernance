import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import { getTranslations } from "next-intl/server";

import { ConstituentForm } from "@/components/constituents/constituent-form";
import { PageHeader } from "@/components/shared/page-header";
import { createServerApiClient } from "@/lib/api/client-server";
import { requirePermission } from "@/lib/auth/guards";
import { FeatureFlagsService, isFlagEnabled } from "@/services/FeatureFlagsService";

export default async function NewConstituentPage() {
  await requirePermission("write");
  const t = await getTranslations("constituentForm");
  const tConstituents = await getTranslations("constituents");

  // Issue #465 — flag on → multiselect type control; off → single Select.
  // Flag-fetch failure defaults to OFF (single picklist), the safe posture.
  let multiTypeEnabled = false;
  try {
    const client = await createServerApiClient();
    const flags = await FeatureFlagsService.listPublic(client);
    multiTypeEnabled = isFlagEnabled(flags, FEATURE_FLAG_KEYS.CONSTITUENTS_MULTI_TYPE);
  } catch {
    multiTypeEnabled = false;
  }

  return (
    <>
      <PageHeader
        title={t("createTitle")}
        description={t("createSubtitle")}
        breadcrumbs={[
          { label: tConstituents("breadcrumbRoot"), href: "/dashboard" },
          { label: tConstituents("title"), href: "/constituents" },
          { label: t("breadcrumbNew") },
        ]}
      />
      <ConstituentForm mode="create" multiTypeEnabled={multiTypeEnabled} />
    </>
  );
}
