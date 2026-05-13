import { UserPlus, Users } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { SettingsNavigation } from "@/components/settings/settings-navigation";
import { EmptyState } from "@/components/shared/empty-state";
import { PageHeader } from "@/components/shared/page-header";
import { createServerApiClient } from "@/lib/api/client-server";
import { requireAuth } from "@/lib/auth/guards";
import { isFeatureFlagsPhase2Enabled } from "@/lib/feature-flags/server";
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
 *   1. **Members** — accepted teammates from `GET /v1/users` (paginated
 *      since PR #185 review PJD-6). Org_admins can edit each member's
 *      display name + role from a row-level dialog, or remove them. The
 *      caller's own row hides the role Select (the API still enforces
 *      `cannot_self_demote` as the durable gate).
 *   2. **Invitations** — pending / accepted / expired invitations from
 *      `GET /v1/invitations`. Resend / revoke affordances unchanged.
 *
 * Pagination uses distinct query params (`mPage` / `iPage`) so the two
 * tables don't share state. When BOTH lists are empty (a fresh tenant),
 * a single combined onboarding empty state is rendered instead of two
 * stacked cards (review D8).
 */
export default async function MembersPage({ searchParams }: MembersPageProps) {
  const auth = await requireAuth();
  const params = await searchParams;
  const t = await getTranslations("settings.members");
  const tSettings = await getTranslations("settings");

  const memberPage = parsePositiveInt(params.mPage, 1);
  const memberPerPage = parsePositiveInt(params.mPerPage, DEFAULT_PER_PAGE, MAX_PER_PAGE);
  const invitationPage = parsePositiveInt(params.iPage, 1);
  const invitationPerPage = parsePositiveInt(params.iPerPage, DEFAULT_PER_PAGE, MAX_PER_PAGE);
  const canManageMembers = auth.roles.includes("org_admin");

  const client = await createServerApiClient();
  // Members are org_admin-gated server-side. For non-admins we deliberately
  // skip the member call (would 403) and skip `getMe` too (only used to
  // render `<InviteAction>` which itself only renders for admins — review
  // E10 saved one round-trip for viewers).
  const [invitationsResult, members, me] = await Promise.all([
    InvitationService.listInvitations(client, {
      page: invitationPage,
      perPage: invitationPerPage,
    }),
    canManageMembers
      ? MemberService.listMembers(client, { page: memberPage, perPage: memberPerPage })
      : Promise.resolve(null),
    canManageMembers ? UserService.getMe(client) : Promise.resolve(null),
  ]);

  const invitationCount = invitationsResult.pagination.total;
  const memberCount = members?.pagination.total ?? 0;
  const bothEmpty = invitationCount === 0 && memberCount === 0;
  // Phase 2 (Epic #365): only surface the Feature flags nav entry when the self-flag is on.
  const showFeatureFlags = await isFeatureFlagsPhase2Enabled();

  return (
    <>
      <PageHeader
        title={t("title")}
        description={
          // Review PJD-1: subtitle keys count by ACTIVE MEMBERS, not by
          // members-or-invitations. Using a combined total rendered
          // "0 members on file" on a fresh tenant with one pending invite.
          memberCount > 0 ? t("subtitleWithCount", { count: memberCount }) : t("subtitleEmpty")
        }
        breadcrumbs={[
          { label: tSettings("breadcrumbRoot"), href: "/dashboard" },
          { label: tSettings("title"), href: "/settings" },
          { label: t("title") },
        ]}
        actions={
          canManageMembers && me ? (
            <InviteAction tenantDefaultLocale={me.tenantDefaultLocale} />
          ) : null
        }
      />
      <SettingsNavigation showFeatureFlags={showFeatureFlags} />

      {bothEmpty && canManageMembers ? (
        // Review D8 — single combined empty state for a fresh tenant
        // ("one screen, one CTA"). Once either list is non-empty the
        // page falls through to the two-section layout below.
        <div className="rounded-2xl bg-surface-container-lowest shadow-card">
          <EmptyState
            icon={UserPlus}
            title={t("combinedEmpty.title")}
            description={t("combinedEmpty.description")}
          />
        </div>
      ) : (
        <>
          {canManageMembers && members ? (
            <section aria-labelledby="members-section-heading" className="space-y-3">
              <header>
                <h2 id="members-section-heading" className="text-lg font-semibold text-on-surface">
                  {t("membersSection.title")}
                </h2>
                <p className="text-sm text-on-surface-variant">{t("membersSection.description")}</p>
              </header>
              {memberCount > 0 ? (
                <MembersTable
                  members={members.data}
                  pagination={members.pagination}
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
              <h2
                id="invitations-section-heading"
                className="text-lg font-semibold text-on-surface"
              >
                {t("invitationsSection.title")}
              </h2>
              <p className="text-sm text-on-surface-variant">
                {/* Review D9 — non-admins see only the invitations section,
                    so add a one-liner pointing them at an admin if they
                    need to manage actual members. */}
                {canManageMembers
                  ? t("invitationsSection.description")
                  : t("invitationsSection.descriptionNonAdmin")}
              </p>
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
      )}
    </>
  );
}
