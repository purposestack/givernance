import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { EndImpersonationSessionButton } from "@/components/admin/end-impersonation-session-button";
import { ReplicateImpersonationSessionButton } from "@/components/admin/replicate-impersonation-session-button";
import { Button } from "@/components/ui/button";
import { createServerApiClient } from "@/lib/api/client-server";
import { isImpersonationReplicateEnabled } from "@/lib/feature-flags/server";
import { cn } from "@/lib/utils";
import {
  ImpersonationService,
  type ImpersonationSessionDTO,
} from "@/services/ImpersonationService";

export const dynamic = "force-dynamic";

type DerivedStatus = "active" | "ended" | "revoked" | "expired";

/**
 * URL-driven filter for the past-sessions section. `null` = show all.
 * Validated from `searchParams.mode` server-side so a tampered value
 * (`?mode=delete-everything`) silently falls back to `null` instead of
 * leaking down into the row filter.
 */
type ModeFilter = "delegation" | "impersonation" | null;

function parseModeFilter(value: string | string[] | undefined): ModeFilter {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === "delegation" || raw === "impersonation") return raw;
  return null;
}

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
 *
 * History section accepts a `?mode=delegation|impersonation` URL param
 * (issue #428 follow-up) so the operator can narrow the past-sessions
 * table to just one mode without losing the full counts on the chips.
 * Active section is always unfiltered — the filter intent is "find a
 * past session I want to inspect or replicate."
 */
interface ImpersonationListPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ImpersonationListPage({ searchParams }: ImpersonationListPageProps) {
  const t = await getTranslations("admin.impersonation");
  const [params, client] = await Promise.all([searchParams, createServerApiClient()]);
  const modeFilter = parseModeFilter(params.mode);

  // Two independent SSR fetches — kick off in parallel so the page
  // doesn't block on serial round-trips. `?all=true` returns historical
  // sessions too (newest-first); the flag fetch decides whether the
  // past-rows table renders the Replicate row-action (issue #428).
  const [sessionsRes, replicateEnabled] = await Promise.all([
    ImpersonationService.listSessions(client, { all: true, limit: 200 }),
    isImpersonationReplicateEnabled(),
  ]);
  const { data } = sessionsRes;

  const active = data.filter((s) => deriveStatus(s) === "active");
  // Full past-session set BEFORE the mode filter — used to compute the
  // chip counts so the "All" chip stays accurate even when narrowed.
  const pastAll = data.filter((s) => deriveStatus(s) !== "active");
  const past = modeFilter === null ? pastAll : pastAll.filter((s) => s.mode === modeFilter);
  const counts = {
    all: pastAll.length,
    delegation: pastAll.filter((s) => s.mode === "delegation").length,
    impersonation: pastAll.filter((s) => s.mode === "impersonation").length,
  };

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
          <SessionTable rows={active} rowActions="end" />
        )}
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold">{t("sectionHistory", { count: past.length })}</h2>
          <ModeFilterTabs activeFilter={modeFilter} counts={counts} />
        </div>
        {past.length === 0 ? (
          <EmptyState
            label={
              modeFilter === null
                ? t("emptyHistory")
                : modeFilter === "delegation"
                  ? t("emptyHistoryDelegation")
                  : t("emptyHistoryImpersonation")
            }
          />
        ) : (
          <SessionTable rows={past} rowActions={replicateEnabled ? "replicate" : "none"} />
        )}
      </section>
    </main>
  );
}

/**
 * URL-driven segmented control above the past-sessions table.
 *
 * Visually mirrors the design-system `Tabs` / `TabsList` / `TabsTrigger`
 * primitives in `@/components/ui/tabs` (Radix-based; used on the
 * tenant detail page and elsewhere) — same `surface-container-low`
 * track, same `surface-container-lowest + shadow-xs` active pip,
 * same `rounded-[var(--radius-md)]` outer / `rounded-[var(--radius-sm)]`
 * inner radii. The shared visual primitive is intentional so the
 * operator's mental model of "this is a tab strip / segmented filter"
 * stays consistent across admin surfaces.
 *
 * Why this isn't `<Tabs>` itself: Radix Tabs is a Client Component
 * with internal `value` state. Driving the filter through the URL
 * (so back/forward navigation mirrors the operator's filter history,
 * AND the page stays SSR with no JS payload) requires plain `<Link>`
 * triggers — which Radix's `<TabsTrigger>` does support via
 * `asChild`, but only when the parent Tabs is mounted on the client.
 * Re-implementing the same visual contract here keeps the page
 * server-rendered without giving up the design-system look.
 */
async function ModeFilterTabs({
  activeFilter,
  counts,
}: {
  activeFilter: ModeFilter;
  counts: { all: number; delegation: number; impersonation: number };
}) {
  const t = await getTranslations("admin.impersonation");
  // Track and trigger classes lifted verbatim from
  // `@/components/ui/tabs` so any future design-token change
  // (e.g., tweaking the active shadow) propagates here too.
  const trackClass = cn(
    "inline-flex items-center gap-1 p-1",
    "bg-surface-container-low text-on-surface-variant",
    "rounded-[var(--radius-md)]",
  );
  const triggerBase = cn(
    "inline-flex items-center justify-center whitespace-nowrap",
    "px-3 py-1.5 text-sm font-medium",
    "rounded-[var(--radius-sm)] transition-colors duration-normal ease-out",
    "focus-visible:outline-none focus-visible:shadow-ring",
  );
  const triggerActive = "bg-surface-container-lowest text-on-surface shadow-xs";

  return (
    <nav aria-label={t("filterByModeAriaLabel")} className={trackClass}>
      <Link
        href="/admin/impersonation"
        className={cn(triggerBase, activeFilter === null && triggerActive)}
        aria-current={activeFilter === null ? "page" : undefined}
      >
        {t("filterAll", { count: counts.all })}
      </Link>
      <Link
        href="/admin/impersonation?mode=delegation"
        className={cn(triggerBase, activeFilter === "delegation" && triggerActive)}
        aria-current={activeFilter === "delegation" ? "page" : undefined}
      >
        {t("filterDelegation", { count: counts.delegation })}
      </Link>
      <Link
        href="/admin/impersonation?mode=impersonation"
        className={cn(triggerBase, activeFilter === "impersonation" && triggerActive)}
        aria-current={activeFilter === "impersonation" ? "page" : undefined}
      >
        {t("filterImpersonation", { count: counts.impersonation })}
      </Link>
    </nav>
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

/**
 * Per-section row action mode. `end` = active row with the End-Session
 * button. `replicate` = past row with the Replicate row-action (issue
 * #428, gated on `admin.impersonation_replicate`). `none` = past row
 * with the flag off, only the View button renders.
 */
type RowActions = "end" | "replicate" | "none";

async function SessionTable({
  rows,
  rowActions,
}: {
  rows: ImpersonationSessionDTO[];
  rowActions: RowActions;
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
            <SessionRow key={session.id} session={session} rowActions={rowActions} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

async function SessionRow({
  session,
  rowActions,
}: {
  session: ImpersonationSessionDTO;
  rowActions: RowActions;
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
          {rowActions === "end" && <EndImpersonationSessionButton sessionId={session.id} />}
          {/*
            Replicate variants when `rowActions === "replicate"` (flag
            ON; off-state QA invariant: flag OFF means this branch is
            never reached and the column ends with only the View button):
              - `targetUserId !== null` → render the active button.
              - `targetUserId === null` → render a disabled marker
                explaining *why* Replicate is unavailable (off-boarded
                target). Pre-fix the row was visually identical to a
                flag-off row, which read as "Replicate is gone" rather
                than "the target this session ran against has been
                hard-deleted" — SOC + ops feedback, PR #429 review.
           */}
          {rowActions === "replicate" &&
            (session.targetUserId !== null ? (
              <ReplicateImpersonationSessionButton
                targetUserId={session.targetUserId}
                mode={session.mode}
                reason={session.reason}
                targetKeycloakId={session.targetKeycloakId}
                targetOrgId={session.targetOrgId}
                targetRole={session.targetRole}
                targetFirstName={session.targetFirstName}
                targetLastName={session.targetLastName}
                targetEmail={session.targetEmail}
                tenantName={session.tenantName}
                tenantSlug={session.tenantSlug}
              />
            ) : (
              <span
                className="text-xs italic text-muted-foreground"
                title={t("replicateUnavailableOffboarded")}
              >
                {t("replicateUnavailableShort")}
              </span>
            ))}
        </div>
      </td>
    </tr>
  );
}
