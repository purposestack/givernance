import { getTranslations } from "next-intl/server";

import { NotificationPreferencesForm } from "@/components/notifications/notification-preferences-form";
import { PageHeader } from "@/components/shared/page-header";
import { createServerApiClient } from "@/lib/api/client-server";
import { requireAuth } from "@/lib/auth/guards";
import { NotificationsService } from "@/services/NotificationsService";

/**
 * Notification preferences (Epic #363, GLO-004).
 *
 * Per-user × per-type channel matrix (in-app + email digest). Mounted
 * under `/profile/notifications` rather than `/settings/notifications`
 * because:
 *   - The `(settings)` layout requires `org_admin` for organisation-
 *     wide controls; notification preferences are personal and must
 *     be reachable by every authenticated role (GLO-004 spec: "Rôles
 *     autorisés: Tous les rôles authentifiés").
 *   - `/profile/*` already houses personal preferences (locale).
 */
export default async function NotificationPreferencesPage() {
  await requireAuth();
  const api = await createServerApiClient();

  const t = await getTranslations("notifications.preferencesPage");
  const initial = await NotificationsService.listPreferences(api);

  return (
    <div className="space-y-8">
      <PageHeader
        title={t("title")}
        description={t("subtitle")}
        breadcrumbs={[
          { label: t("breadcrumbRoot"), href: "/dashboard" },
          { label: t("breadcrumbProfile"), href: "/profile" },
          { label: t("title") },
        ]}
      />
      <NotificationPreferencesForm initial={initial} />
    </div>
  );
}
