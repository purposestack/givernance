import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { NewTenantForm } from "@/components/admin/new-tenant-form";

/**
 * Super-admin enterprise tenant creation page (issue #111 / doc 22 §6.4).
 *
 * Provisions the tenant row + Keycloak Organization via `POST /v1/superadmin/tenants`.
 * After creation, the operator lands on the tenant detail page to claim a
 * domain, provision the IdP, and invite the first admin. The `(admin)`
 * layout enforces `super_admin` via `requireAuth` + 404 on mismatch.
 */
export default async function NewTenantPage() {
  const t = await getTranslations("admin.tenants.new");

  return (
    <div className="space-y-8">
      <header>
        <Link href="/admin/tenants" className="text-xs font-medium text-primary hover:underline">
          ← {t("back")}
        </Link>
        <h1 className="mt-2 font-heading text-2xl text-on-surface">{t("title")}</h1>
        <p className="mt-1 text-sm text-on-surface-variant">{t("subtitle")}</p>
      </header>

      <NewTenantForm />

      <section className="rounded-2xl border border-outline-variant bg-primary-50 p-6">
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-primary">
          {t("nextSteps.title")}
        </h2>
        <ol className="ml-5 list-decimal space-y-2 text-sm text-on-surface-variant">
          <li>{t("nextSteps.step1")}</li>
          <li>{t("nextSteps.step2")}</li>
          <li>{t("nextSteps.step3")}</li>
        </ol>
      </section>
    </div>
  );
}
