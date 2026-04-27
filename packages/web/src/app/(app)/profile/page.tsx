import { getTranslations } from "next-intl/server";
import { ProfileLanguageForm } from "@/components/profile/profile-language-form";
import { PageHeader } from "@/components/shared/page-header";
import { createServerApiClient } from "@/lib/api/client-server";
import { requireAuth } from "@/lib/auth/guards";
import { UserService } from "@/services/UserService";

/**
 * Personal profile / preferences (issue #153).
 *
 * Available to every authenticated role — `users.locale` is the user's
 * own preference, distinct from the org-wide `tenants.default_locale`
 * which is admin-only on `/settings`. The page is intentionally minimal
 * (one section: language) and shaped to absorb additional preferences
 * — timezone, notification settings, etc. — without restructuring.
 */
export default async function ProfilePage() {
  await requireAuth();
  const t = await getTranslations("profile");

  // Server-fetch the profile so the form renders synchronously without a
  // loading flash. The PATCH on submit re-bases the form's state from
  // the response, so the server-side snapshot is only ever the seed.
  const api = await createServerApiClient();
  const me = await UserService.getMe(api);

  return (
    <div className="space-y-8">
      <PageHeader
        title={t("title")}
        description={t("subtitle")}
        breadcrumbs={[{ label: t("breadcrumbRoot"), href: "/dashboard" }, { label: t("title") }]}
      />
      <ProfileLanguageForm initial={me} />
    </div>
  );
}
