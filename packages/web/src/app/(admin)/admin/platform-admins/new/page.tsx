import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { NewPlatformAdminForm } from "@/components/admin/new-platform-admin-form";

/**
 * Super-admin-only page for inviting a new platform admin (issue #254).
 * The `(admin)` layout guards on `super_admin`; non-super-admins land on
 * the platform 404 instead.
 */
export default async function NewPlatformAdminPage() {
  const t = await getTranslations("admin.platformAdmins.new");
  return (
    <div className="space-y-8">
      <header>
        <Link
          href="/admin/platform-admins"
          className="text-xs font-medium text-primary hover:underline"
        >
          {t("back")}
        </Link>
        <h1 className="mt-2 font-heading text-2xl text-on-surface">{t("title")}</h1>
        <p className="mt-1 text-sm text-on-surface-variant">{t("subtitle")}</p>
      </header>

      <div className="rounded-2xl border border-outline-variant bg-surface p-6">
        <NewPlatformAdminForm />
      </div>
    </div>
  );
}
