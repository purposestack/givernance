import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { DonationForm } from "@/components/donations/donation-form";
import { fetchCustomFieldDefinitionsOrEmpty } from "@/components/shared/custom-fields";
import { PageHeader } from "@/components/shared/page-header";
import { ApiProblem } from "@/lib/api";
import { createServerApiClient } from "@/lib/api/client-server";
import { requirePermission } from "@/lib/auth/guards";
import { type DonationDetail, donationDetailDonorName } from "@/models/donation";
import { DonationService } from "@/services/DonationService";
import { FeatureFlagsService, isFlagEnabled } from "@/services/FeatureFlagsService";

interface EditDonationPageProps {
  params: Promise<{ id: string }>;
}

async function fetchDonationOrNotFound(id: string): Promise<DonationDetail> {
  const client = await createServerApiClient();

  try {
    return await DonationService.getDonation(client, id);
  } catch (err) {
    if (err instanceof ApiProblem && err.status === 404) {
      notFound();
    }

    throw err;
  }
}

export default async function EditDonationPage({ params }: EditDonationPageProps) {
  await requirePermission("write");
  const { id } = await params;
  const donation = await fetchDonationOrNotFound(id);

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

  const t = await getTranslations("donations.form");
  const tDonations = await getTranslations("donations");

  // ADR-035 rules A2 + E19 — header reveals, then the form enters as ONE
  // block (no per-field choreography), mirroring /donations/new.
  return (
    <>
      <PageHeader
        title={t("editTitle")}
        description={t("editSubtitle")}
        breadcrumbs={[
          { label: tDonations("breadcrumbRoot"), href: "/dashboard" },
          { label: tDonations("title"), href: "/donations" },
          {
            label: donationDetailDonorName(donation) || tDonations("anonymousDonor"),
            href: `/donations/${donation.id}`,
          },
          { label: t("breadcrumbEdit") },
        ]}
      />
      <div className="reveal-item">
        <DonationForm mode="edit" donation={donation} customFieldDefs={customFieldDefs} />
      </div>
    </>
  );
}
