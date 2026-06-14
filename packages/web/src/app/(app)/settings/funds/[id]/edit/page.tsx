import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { FundForm } from "@/components/settings/fund-form";
import { SettingsNavigation } from "@/components/settings/settings-navigation";
import { PageHeader } from "@/components/shared/page-header";
import { ApiProblem } from "@/lib/api";
import { createServerApiClient } from "@/lib/api/client-server";
import { requireAuth } from "@/lib/auth/guards";
import type { Fund } from "@/models/fund";
import { FundService } from "@/services/FundService";

interface EditFundPageProps {
  params: Promise<{ id: string }>;
}

async function fetchFundOrNotFound(id: string): Promise<Fund> {
  const client = await createServerApiClient();

  try {
    return await FundService.getFund(client, id);
  } catch (err) {
    if (err instanceof ApiProblem && err.status === 404) {
      notFound();
    }

    throw err;
  }
}

export default async function EditFundPage({ params }: EditFundPageProps) {
  const auth = await requireAuth();
  const { id } = await params;
  const fund = await fetchFundOrNotFound(id);

  const t = await getTranslations("settings.funds");
  const tSettings = await getTranslations("settings");
  const tForm = await getTranslations("settings.funds.form");

  return (
    <>
      <PageHeader
        title={tForm("editTitle")}
        description={tForm("editSubtitle")}
        breadcrumbs={[
          { label: tSettings("breadcrumbRoot"), href: "/dashboard" },
          { label: t("settings"), href: "/settings" },
          { label: t("title"), href: "/settings/funds" },
          { label: fund.name },
          { label: tForm("breadcrumbEdit") },
        ]}
      />
      <SettingsNavigation />
      <FundForm mode="edit" fund={fund} canManageFunds={auth.roles.includes("org_admin")} />
    </>
  );
}
