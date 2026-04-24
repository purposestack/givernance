import { getTranslations } from "next-intl/server";

import { DonationForm } from "@/components/donations/donation-form";
import { PageHeader } from "@/components/shared/page-header";
import { requireAuth } from "@/lib/auth/guards";

export default async function NewDonationPage() {
  await requireAuth();
  const t = await getTranslations("donations.form");
  const tDonations = await getTranslations("donations");

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
      <DonationForm mode="create" />
    </>
  );
}
