import { getTranslations } from "next-intl/server";
import type { CSSProperties } from "react";

import { DonationForm } from "@/components/donations/donation-form";
import { PageHeader } from "@/components/shared/page-header";
import { requirePermission } from "@/lib/auth/guards";

export default async function NewDonationPage() {
  await requirePermission("write");
  const t = await getTranslations("donations.form");
  const tDonations = await getTranslations("donations");

  // ADR-035 rules A2 + E19 — header reveals, then the form enters as ONE
  // block: forms get no per-field choreography (motion that doesn't
  // communicate loading order doesn't ship).
  return (
    <>
      <PageHeader
        className="reveal-item"
        title={t("createTitle")}
        description={t("createSubtitle")}
        breadcrumbs={[
          { label: tDonations("breadcrumbRoot"), href: "/dashboard" },
          { label: tDonations("title"), href: "/donations" },
          { label: t("breadcrumbNew") },
        ]}
      />
      <div className="reveal-item" style={{ "--cascade-i": 1 } as CSSProperties}>
        <DonationForm mode="create" />
      </div>
    </>
  );
}
