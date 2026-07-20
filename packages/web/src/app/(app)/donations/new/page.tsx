import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import { getTranslations } from "next-intl/server";

import { DonationForm } from "@/components/donations/donation-form";
import { fetchCustomFieldDefinitionsOrEmpty } from "@/components/shared/custom-fields";
import { PageHeader } from "@/components/shared/page-header";
import { createServerApiClient } from "@/lib/api/client-server";
import { requirePermission } from "@/lib/auth/guards";
import { FeatureFlagsService, isFlagEnabled } from "@/services/FeatureFlagsService";

export default async function NewDonationPage() {
  await requirePermission("write");
  const t = await getTranslations("donations.form");
  const tDonations = await getTranslations("donations");

  // Epic #539 — flag off / fetch failure ⇒ no defs ⇒ no custom section.
  let customFieldsEnabled = false;
  const client = await createServerApiClient();
  try {
    const flags = await FeatureFlagsService.listPublic(client);
    customFieldsEnabled = isFlagEnabled(flags, FEATURE_FLAG_KEYS.DONATIONS_CUSTOM_FIELDS);
  } catch {
    customFieldsEnabled = false;
  }
  const customFieldDefs = await fetchCustomFieldDefinitionsOrEmpty(
    client,
    "donation",
    customFieldsEnabled,
  );

  // ADR-035 rules A2 + E19 — header reveals, then the form enters as ONE
  // block: forms get no per-field choreography (motion that doesn't
  // communicate loading order doesn't ship).
  return (
    <>
      <PageHeader
        title={t("createTitle")}
        description={t("createSubtitle")}
        breadcrumbs={[
          { label: tDonations("breadcrumbRoot"), href: "/dashboard" },
          { label: tDonations("title"), href: "/donations" },
          { label: t("breadcrumbNew") },
        ]}
      />
      <div className="reveal-item">
        <DonationForm mode="create" customFieldDefs={customFieldDefs} />
      </div>
    </>
  );
}
