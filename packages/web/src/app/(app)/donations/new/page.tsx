import { getTranslations } from "next-intl/server";

import { DonationForm } from "@/components/donations/donation-form";
import { PageHeader } from "@/components/shared/page-header";
import { createServerApiClient } from "@/lib/api/client-server";
import { requirePermission } from "@/lib/auth/guards";
import { CampaignService } from "@/services/CampaignService";

interface NewDonationPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function extractString(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function NewDonationPage({ searchParams }: NewDonationPageProps) {
  await requirePermission("write");
  const t = await getTranslations("donations.form");
  const tDonations = await getTranslations("donations");

  const sp = await searchParams;
  const initialConstituentId = extractString(sp.constituentId);
  const initialCampaignId = extractString(sp.campaignId);

  // Resolve the campaign's defaultCurrency so the form opens in the right currency
  let initialCurrency: string | undefined;
  if (initialCampaignId) {
    try {
      const client = await createServerApiClient();
      const campaign = await CampaignService.getCampaign(client, initialCampaignId);
      initialCurrency = campaign.defaultCurrency ?? undefined;
    } catch {
      // Non-fatal: form will use the tenant default
    }
  }

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
        initialCurrency={initialCurrency}
      />
    </>
  );
}
