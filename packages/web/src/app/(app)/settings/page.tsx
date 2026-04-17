import { getTranslations } from "next-intl/server";

import { requireAuth } from "@/lib/auth/guards";

/**
 * Settings page — protected, requires authentication.
 * Placeholder for Phase 2 implementation (ADM-001 org settings).
 */
export default async function SettingsPage() {
  await requireAuth();
  const t = await getTranslations("appShell.sidebar");

  return (
    <>
      <div className="mb-8">
        <h1 className="font-heading text-5xl font-normal leading-tight tracking-tight text-on-surface">
          {t("settings")}
        </h1>
      </div>

      <div className="rounded-2xl bg-surface-container-lowest p-8 shadow-card">
        <p className="text-sm text-text-secondary">Settings page under construction.</p>
      </div>
    </>
  );
}
