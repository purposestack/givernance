import { getTranslations } from "next-intl/server";
import { StartImpersonationForm } from "@/components/admin/start-impersonation-form";

export const dynamic = "force-dynamic";

/**
 * Start a new support session (issue #24).
 *
 * The form is a Client Component because the POST flow needs to (a) read
 * the CSRF cookie via `document.cookie`, (b) submit JSON, and (c) navigate
 * the operator's session over to the impersonation cookie. The Page itself
 * is a Server Component so locale/translations are server-resolved.
 */
export default async function NewImpersonationPage() {
  const t = await getTranslations("admin.impersonation.new");
  return (
    <main id="main-content" className="mx-auto max-w-2xl space-y-6 p-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </header>
      <StartImpersonationForm />
    </main>
  );
}
