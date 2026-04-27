import { Users } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { SettingsNavigation } from "@/components/settings/settings-navigation";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { createServerApiClient } from "@/lib/api/client-server";
import { requireAuth } from "@/lib/auth/guards";
import { InvitationService } from "@/services/InvitationService";
import { MemberService } from "@/services/MemberService";
import { UserService } from "@/services/UserService";

import { InvitationsTable } from "./invitations-table";
import { InviteAction } from "./invite-action";
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
 * Issue #161 split the page into two stacked tables:
 *
 *   1. **Members** — accepted teammates from `GET /v1/users`. Org_admins
 *      can edit each member's display name + role from a row-level dialog,
 *      or remove them. The caller's own row hides the role Select (the
 *      API still enforces `cannot_self_demote` as the durable gate).
 *   2. **Invitations** — pending / accepted / expired invitations from
 *      `GET /v1/invitations`. Resend / revoke affordances unchanged.
 *
 * Listing both is intentional: a "still pending" invitation has different
 * affordances (resend, revoke) than an actual member (edit name/role,
 * remove), so the previous mixed table conflated two domain objects.
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
  // Members are org_admin-gated server-side. For non-admins we deliberately
  // skip the call (would 403) so the page still renders the invitations
  // section, which any authenticated user can read.
  const [invitationsResult, me, members] = await Promise.all([
    InvitationService.listInvitations(client, { page, perPage }),
    UserService.getMe(client),
    canManageMembers ? MemberService.listMembers(client) : Promise.resolve([]),
  ]);

  const invitationCount = invitationsResult.pagination.total;
  const memberCount = members.length;
  const totalCount = invitationCount + memberCount;

  return (
    <>
      <PageHeader
        title={t("title")}
        description={
          totalCount > 0 ? t("subtitleWithCount", { count: memberCount }) : t("subtitleEmpty")
        }
        breadcrumbs={[
          { label: tSettings("breadcrumbRoot"), href: "/dashboard" },
          { label: tSettings("title"), href: "/settings" },
          { label: t("title") },
        ]}
        actions={
          canManageMembers ? <InviteAction tenantDefaultLocale={me.tenantDefaultLocale} /> : null
        }
      />
      <SettingsNavigation />

      {canManageMembers ? (
        <section aria-labelledby="members-section-heading" className="space-y-3">
          <header>
            <h2 id="members-section-heading" className="text-lg font-semibold text-on-surface">
              {t("membersSection.title")}
            </h2>
            <p className="text-sm text-on-surface-variant">{t("membersSection.description")}</p>
          </header>
          {memberCount > 0 ? (
            <MembersTable
              members={members}
              canManageMembers={canManageMembers}
              currentUserKeycloakId={auth.userId}
            />
          ) : (
            <div className="rounded-2xl bg-surface-container-lowest shadow-card">
              <EmptyState
                icon={Users}
                title={t("membersSection.empty.title")}
                description={t("membersSection.empty.description")}
              />
            </div>
          )}
        </section>
      ) : null}

      <section aria-labelledby="invitations-section-heading" className="space-y-3">
        <header>
          <h2 id="invitations-section-heading" className="text-lg font-semibold text-on-surface">
            {t("invitationsSection.title")}
          </h2>
          <p className="text-sm text-on-surface-variant">{t("invitationsSection.description")}</p>
        </header>
        {invitationCount > 0 ? (
          <InvitationsTable
            invitations={invitationsResult.data}
            pagination={invitationsResult.pagination}
            canManageMembers={canManageMembers}
          />
        ) : (
          <div className="rounded-2xl bg-surface-container-lowest shadow-card">
            <EmptyState
              icon={Users}
              title={t("invitationsSection.empty.title")}
              description={t("invitationsSection.empty.description")}
            />
          </div>
        )}
      </section>
    </>
  );
}
