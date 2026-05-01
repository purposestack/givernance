import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { EndImpersonationSessionButton } from "@/components/admin/end-impersonation-session-button";
import { Button } from "@/components/ui/button";
import { createServerApiClient } from "@/lib/api/client-server";
import {
  ImpersonationService,
  type ImpersonationSessionDTO,
} from "@/services/ImpersonationService";

export const dynamic = "force-dynamic";

type DerivedStatus = "active" | "ended" | "revoked" | "expired";

function deriveStatus(s: ImpersonationSessionDTO): DerivedStatus {
  if (s.isActive) return "active";
  if (s.endReason === "revoked") return "revoked";
  if (s.endReason === "manual" || s.endReason === "switched") return "ended";
  // No endReason + expired-by-time → derived expired (TTL reached, no
  // explicit DELETE recorded). Matches doc-19 §4 state machine.
  return "expired";
}

/**
 * Cross-operator support-session listing (issue #24).
 *
 * Lists every session across the platform — active AND historical — for
 * any super_admin to inspect. The backend has no impersonator filter on
 * `listSessions`, so a super_admin can audit a colleague's sessions
 * (useful when the originating super_admin is on holiday and an incident
 * needs to be investigated).
 */
export default async function ImpersonationListPage() {
  const t = await getTranslations("admin.impersonation");
  const client = await createServerApiClient();
  // ?all=true returns historical sessions too — newest-first.
  const { data } = await ImpersonationService.listSessions(client, { all: true, limit: 200 });

  const active = data.filter((s) => deriveStatus(s) === "active");
  const past = data.filter((s) => deriveStatus(s) !== "active");

  return (
    <main id="main-content" className="mx-auto max-w-6xl space-y-8 p-6">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{t("listTitle")}</h1>
          <p className="text-sm text-muted-foreground">{t("listSubtitleAll")}</p>
        </div>
        <Button asChild>
          <Link href="/admin/impersonation/new">{t("startNew")}</Link>
        </Button>
      </header>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">{t("sectionActive", { count: active.length })}</h2>
        {active.length === 0 ? (
          <EmptyState label={t("emptyActive")} />
        ) : (
          <SessionTable rows={active} showActions />
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-base font-semibold">{t("sectionHistory", { count: past.length })}</h2>
        {past.length === 0 ? (
          <EmptyState label={t("emptyHistory")} />
        ) : (
          <SessionTable rows={past} showActions={false} />
        )}
      </section>
    </main>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-6 py-8 text-center text-sm text-muted-foreground">
      {label}
    </div>
  );
}

/**
 * Renders a person + (optional) tenant + UUID side-note in a single
 * column cell. Falls back gracefully:
 *   - No first/last name → render the email if we have it, otherwise the
 *     keycloak_id raw (and skip the side-note since it's the same).
 *   - The side-note is the keycloak_id, mono and dim, for ops who need
 *     to copy/paste an identifier into a debugger or a Loki query.
 */
function UserCell({
  firstName,
  lastName,
  email,
  tenantName,
  tenantSlug,
  keycloakId,
}: {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  tenantName: string | null;
  tenantSlug: string | null;
  keycloakId: string;
}) {
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
  const hasName = fullName.length > 0;

  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-sm font-medium">
        {hasName ? fullName : (email ?? <code className="font-mono text-xs">{keycloakId}</code>)}
      </span>
      {tenantName && (
        <span className="text-xs text-muted-foreground">
          {tenantName}
          {tenantSlug ? <span className="opacity-60"> ({tenantSlug})</span> : null}
        </span>
      )}
      {hasName && (
        <code className="font-mono text-[10px] text-muted-foreground/70" title={keycloakId}>
          {keycloakId}
        </code>
      )}
    </div>
  );
}

async function SessionTable({
  rows,
  showActions,
}: {
  rows: ImpersonationSessionDTO[];
  showActions: boolean;
}) {
  const t = await getTranslations("admin.impersonation");
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <table className="min-w-full text-sm">
        <thead className="bg-surface-variant text-left text-xs uppercase tracking-wider text-muted-foreground">
          <tr>
            <th className="px-4 py-3">{t("colStatus")}</th>
            <th className="px-4 py-3">{t("colMode")}</th>
            <th className="px-4 py-3">{t("colTarget")}</th>
            <th className="px-4 py-3">{t("colImpersonator")}</th>
            <th className="px-4 py-3">{t("colReason")}</th>
            <th className="px-4 py-3">{t("colWhen")}</th>
            <th className="px-4 py-3 text-right">{t("colActions")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((session) => (
            <SessionRow key={session.id} session={session} showActions={showActions} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

async function SessionRow({
  session,
  showActions,
}: {
  session: ImpersonationSessionDTO;
  showActions: boolean;
}) {
  const t = await getTranslations("admin.impersonation");
  const status = deriveStatus(session);
  const isPure = session.mode === "impersonation";

  const modeBadgeClass = isPure
    ? "rounded bg-error-light px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-error-text"
    : "rounded bg-amber-light px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-amber-text";

  const statusBadgeClass = {
    active:
      "rounded bg-green-50 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-green-text",
    ended:
      "rounded bg-surface-container px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground",
    revoked:
      "rounded bg-error-light px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-error-text",
    expired:
      "rounded bg-surface-container px-2 py-0.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground",
  }[status];

  const statusLabel = {
    active: t("statusActive"),
    ended: t("statusEnded"),
    revoked: t("statusRevoked"),
    expired: t("statusExpired"),
  }[status];

  const whenLabel =
    status === "active"
      ? t("whenExpiresAt", { time: new Date(session.expiresAt).toLocaleString() })
      : session.endedAt
        ? t("whenEndedAt", { time: new Date(session.endedAt).toLocaleString() })
        : new Date(session.expiresAt).toLocaleString();

  return (
    <tr className="hover:bg-surface-variant/40">
      <td className="px-4 py-3">
        <span className={statusBadgeClass}>{statusLabel}</span>
      </td>
      <td className="px-4 py-3">
        <span className={modeBadgeClass}>
          {isPure ? t("badgeImpersonation") : t("badgeDelegation")}
        </span>
      </td>
      <td className="px-4 py-3">
        <UserCell
          firstName={session.targetFirstName}
          lastName={session.targetLastName}
          email={session.targetEmail}
          tenantName={session.tenantName}
          tenantSlug={session.tenantSlug}
          keycloakId={session.targetKeycloakId}
        />
      </td>
      <td className="px-4 py-3">
        <UserCell
          firstName={session.impersonatorFirstName}
          lastName={session.impersonatorLastName}
          email={session.impersonatorEmail}
          // Operator is super_admin → no tenant context worth surfacing.
          tenantName={null}
          tenantSlug={null}
          keycloakId={session.impersonatorKeycloakId}
        />
      </td>
      <td className="px-4 py-3 max-w-[240px]">
        <span className="line-clamp-2 text-xs">{session.reason}</span>
      </td>
      <td className="px-4 py-3 text-xs">{whenLabel}</td>
      <td className="px-4 py-3 text-right">
        <div className="flex items-center justify-end gap-2">
          <Button asChild size="sm" variant="ghost">
            <Link href={`/admin/impersonation/${session.id}`} prefetch={false}>
              {t("view")}
            </Link>
          </Button>
          {showActions && <EndImpersonationSessionButton sessionId={session.id} />}
        </div>
      </td>
    </tr>
  );
}
