import { getTranslations } from "next-intl/server";
import { SettingsNavigation } from "@/components/settings/settings-navigation";
import { PageHeader } from "@/components/shared/page-header";
import { createServerApiClient } from "@/lib/api/client-server";
import { requireAuth } from "@/lib/auth/guards";
import { InvitationService } from "@/services/InvitationService";

import { MembersTable } from "./members-table";

const DEFAULT_PER_PAGE = 20;
const MAX_PER_PAGE = 100;

interface MembersPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function parsePositiveInt(value: string | string[] | undefined, fallback: number, max?: number) {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return max ? Math.min(parsed, max) : parsed;
}

/**
 * /settings/members — Members & invitations management.
 *
 * Lists every team invitation (pending / accepted / expired) for the
 * current tenant and lets org_admins invite new teammates, resend pending
 * invitations, or revoke them. Non-admins see the data without the action
 * affordances.
 */
export default async function MembersPage({ searchParams }: MembersPageProps) {
  const auth = await requireAuth();
  const params = await searchParams;
  const t = await getTranslations("settings.members");
  const tSettings = await getTranslations("settings");

  const page = parsePositiveInt(params.page, 1);
  const perPage = parsePositiveInt(params.perPage, DEFAULT_PER_PAGE, MAX_PER_PAGE);
  const canManageMembers = auth.roles.includes("org_admin");

  const client = await createServerApiClient();
  const result = await InvitationService.listInvitations(client, { page, perPage });

  const total = result.pagination.total;

  return (
    <>
      <PageHeader
        title={t("title")}
        description={total > 0 ? t("subtitleWithCount", { count: total }) : t("subtitleEmpty")}
        breadcrumbs={[
          { label: tSettings("breadcrumbRoot"), href: "/dashboard" },
          { label: tSettings("title"), href: "/settings" },
          { label: t("title") },
        ]}
      />
      <SettingsNavigation />
      <MembersTable
        invitations={result.data}
        pagination={result.pagination}
        canManageMembers={canManageMembers}
      />
    </>
  );
}
