import { getTranslations } from "next-intl/server";

import { DonationForm } from "@/components/donations/donation-form";
import { PageHeader } from "@/components/shared/page-header";
import { requirePermission } from "@/lib/auth/guards";

export default async function NewDonationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission("write");
  const t = await getTranslations("donations.form");
  const tDonations = await getTranslations("donations");
  const sp = await searchParams;

  const initialConstituentId = typeof sp.constituentId === "string" ? sp.constituentId : undefined;
  const initialCampaignId = typeof sp.campaignId === "string" ? sp.campaignId : undefined;

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
      <DonationForm
        mode="create"
        initialConstituentId={initialConstituentId}
        initialCampaignId={initialCampaignId}
      />
    </>
  );
}
