import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { DonationForm } from "@/components/donations/donation-form";
import { PageHeader } from "@/components/shared/page-header";
import { ApiProblem } from "@/lib/api";
import { createServerApiClient } from "@/lib/api/client-server";
import { requirePermission } from "@/lib/auth/guards";
import { type DonationDetail, donationDetailDonorName } from "@/models/donation";
import { DonationService } from "@/services/DonationService";

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

  const t = await getTranslations("donations.form");
  const tDonations = await getTranslations("donations");

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
      <DonationForm mode="edit" donation={donation} />
    </>
  );
}
