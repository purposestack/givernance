import { FEATURE_FLAG_KEYS } from "@givernance/shared/constants";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { ConstituentForm } from "@/components/constituents/constituent-form";
import { PageHeader } from "@/components/shared/page-header";
import { ApiProblem } from "@/lib/api";
import { createServerApiClient } from "@/lib/api/client-server";
import { requirePermission } from "@/lib/auth/guards";
import { type Constituent, fullName } from "@/models/constituent";
import { ConstituentService } from "@/services/ConstituentService";
import { FeatureFlagsService, isFlagEnabled } from "@/services/FeatureFlagsService";

interface EditConstituentPageProps {
  params: Promise<{ id: string }>;
}

async function fetchConstituentOrNotFound(id: string): Promise<Constituent> {
  const client = await createServerApiClient();
  try {
    return await ConstituentService.getConstituent(client, id);
  } catch (err) {
    if (err instanceof ApiProblem && err.status === 404) {
      notFound();
    }
    throw err;
  }
}

export default async function EditConstituentPage({ params }: EditConstituentPageProps) {
  await requirePermission("write");
  const { id } = await params;
  const constituent = await fetchConstituentOrNotFound(id);

  // Issue #465 — flag on → multiselect type control; off → single Select.
  let multiTypeEnabled = false;
  try {
    const client = await createServerApiClient();
    const flags = await FeatureFlagsService.listPublic(client);
    multiTypeEnabled = isFlagEnabled(flags, FEATURE_FLAG_KEYS.CONSTITUENTS_MULTI_TYPE);
  } catch {
    multiTypeEnabled = false;
  }

  const t = await getTranslations("constituentForm");
  const tConstituents = await getTranslations("constituents");

  const name = fullName(constituent);

  return (
    <>
      <PageHeader
        title={t("editTitle")}
        description={t("editSubtitle")}
        breadcrumbs={[
          { label: tConstituents("breadcrumbRoot"), href: "/dashboard" },
          { label: tConstituents("title"), href: "/constituents" },
          { label: name, href: `/constituents/${constituent.id}` },
          { label: t("breadcrumbEdit") },
        ]}
      />
      <ConstituentForm mode="edit" constituent={constituent} multiTypeEnabled={multiTypeEnabled} />
    </>
  );
}
