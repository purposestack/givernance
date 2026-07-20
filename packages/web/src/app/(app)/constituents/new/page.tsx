import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import { getTranslations } from "next-intl/server";

import { ConstituentForm } from "@/components/constituents/constituent-form";
import { fetchCustomFieldDefinitionsOrEmpty } from "@/components/shared/custom-fields";
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
  // Epic #539 — flag off / fetch failure ⇒ no defs ⇒ no custom section.
  let customFieldsEnabled = false;
  const client = await createServerApiClient();
  try {
    const flags = await FeatureFlagsService.listPublic(client);
    multiTypeEnabled = isFlagEnabled(flags, FEATURE_FLAG_KEYS.CONSTITUENTS_MULTI_TYPE);
    customFieldsEnabled = isFlagEnabled(flags, FEATURE_FLAG_KEYS.CONSTITUENTS_CUSTOM_FIELDS);
  } catch {
    multiTypeEnabled = false;
    customFieldsEnabled = false;
  }
  const customFieldDefs = await fetchCustomFieldDefinitionsOrEmpty(
    client,
    "constituent",
    customFieldsEnabled,
  );

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
      {/* ADR-035 rule E19 — a single fade-rise on the whole form block;
          forms get no per-field choreography. Header stays static. */}
      <div className="reveal-item">
        <ConstituentForm
          mode="create"
          multiTypeEnabled={multiTypeEnabled}
          customFieldDefs={customFieldDefs}
        />
      </div>
    </>
  );
}
