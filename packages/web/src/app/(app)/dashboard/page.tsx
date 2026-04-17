import { getTranslations } from "next-intl/server";

import { requireAuth } from "@/lib/auth/guards";

/**
 * Dashboard page — protected, requires authentication.
 * The app shell (sidebar, topbar) is provided by the (app) layout.
 * Placeholder for Sprint 4 PR-C1 implementation.
 */
export default async function DashboardPage() {
  const auth = await requireAuth();
  const t = await getTranslations("dashboard");

  return (
    <>
      <div className="mb-8">
        <h1 className="font-heading text-5xl font-normal leading-tight tracking-tight text-on-surface">
          {t("greeting", { name: auth.firstName ?? "empty" })}
        </h1>
        <p className="mt-2 text-lg text-on-surface-variant">{t("subtitle")}</p>
      </div>

      <div className="rounded-2xl bg-surface-container-lowest p-8 shadow-card">
        <p className="text-sm text-text-secondary">{t("placeholder")}</p>
      </div>
    </>
  );
}
