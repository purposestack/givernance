import { getTranslations } from "next-intl/server";

import { ConstituentForm } from "@/components/constituents/constituent-form";
import { PageHeader } from "@/components/shared/page-header";
import { requireAuth } from "@/lib/auth/guards";

export default async function NewConstituentPage() {
  await requireAuth();
  const t = await getTranslations("constituentForm");
  const tConstituents = await getTranslations("constituents");

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
      <ConstituentForm mode="create" />
    </>
  );
}
