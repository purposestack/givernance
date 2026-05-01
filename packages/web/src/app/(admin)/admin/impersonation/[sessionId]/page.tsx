import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { EndImpersonationSessionButton } from "@/components/admin/end-impersonation-session-button";
import { createServerApiClient } from "@/lib/api/client-server";
import { ApiProblem } from "@/lib/api/problem";
import { ImpersonationService } from "@/services/ImpersonationService";

export const dynamic = "force-dynamic";

/**
 * Cross-operator session detail (issue #24).
 *
 * Shows the session's metadata + the chronological audit timeline of
 * every action taken under the impersonation cookie. Any super_admin
 * can read any session — useful for incident review when the operator
 * is unavailable (holiday, off-boarded, etc.).
 */
export default async function ImpersonationSessionDetailPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const t = await getTranslations("admin.impersonation.detail");
  const tList = await getTranslations("admin.impersonation");
  const client = await createServerApiClient();

  let sessionData: Awaited<ReturnType<typeof ImpersonationService.getSession>>["data"];
  try {
    const result = await ImpersonationService.getSession(client, sessionId);
    sessionData = result.data;
  } catch (err) {
    if (err instanceof ApiProblem && err.status === 404) notFound();
    throw err;
  }

  const { data: auditRows } = await ImpersonationService.getSessionAudit(client, sessionId);

  const isPure = sessionData.mode === "impersonation";
  const modeBadgeClass = isPure
    ? "rounded bg-error-light px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-error-text"
    : "rounded bg-amber-light px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-amber-text";

  // Status derivation pulled out of JSX so the page handler stays under the
  // cognitive-complexity ceiling (the same shape as the list page's
  // `deriveStatus` helper, kept inline to avoid a third file for one branch).
  const statusLabel = sessionData.isActive
    ? tList("statusActive")
    : sessionData.endReason === "revoked"
      ? tList("statusRevoked")
      : sessionData.endedAt
        ? tList("statusEnded")
        : tList("statusExpired");

  return (
    <main id="main-content" className="mx-auto max-w-5xl space-y-6 p-6">
      <header className="space-y-2">
        <Link
          href="/admin/impersonation"
          className="text-xs text-muted-foreground hover:text-on-surface"
        >
          ← {t("backToList")}
        </Link>
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-2xl font-semibold">{t("title")}</h1>
          {sessionData.isActive && <EndImpersonationSessionButton sessionId={sessionData.id} />}
        </div>
      </header>

      <section className="grid gap-4 rounded-lg border border-border bg-surface p-4 sm:grid-cols-2">
        <Field label={t("fieldId")}>
          <code className="text-xs">{sessionData.id}</code>
        </Field>
        <Field label={t("fieldMode")}>
          <span className={modeBadgeClass}>
            {isPure ? tList("badgeImpersonation") : tList("badgeDelegation")}
          </span>
        </Field>
        <Field label={t("fieldStatus")}>{statusLabel}</Field>
        <Field label={t("fieldTarget")}>
          <PersonBlock
            firstName={sessionData.targetFirstName}
            lastName={sessionData.targetLastName}
            email={sessionData.targetEmail}
            tenantName={sessionData.tenantName}
            tenantSlug={sessionData.tenantSlug}
            keycloakId={sessionData.targetKeycloakId}
            secondaryLine={t("targetRole", { role: sessionData.targetRole })}
          />
        </Field>
        <Field label={t("fieldOperator")}>
          <PersonBlock
            firstName={sessionData.impersonatorFirstName}
            lastName={sessionData.impersonatorLastName}
            email={sessionData.impersonatorEmail}
            tenantName={null}
            tenantSlug={null}
            keycloakId={sessionData.impersonatorKeycloakId}
          />
        </Field>
        <Field label={t("fieldStarted")}>
          <span className="text-xs">{new Date(sessionData.createdAt).toLocaleString()}</span>
        </Field>
        <Field label={t("fieldExpires")}>
          <span className="text-xs">{new Date(sessionData.expiresAt).toLocaleString()}</span>
        </Field>
        <Field label={t("fieldEnded")}>
          <span className="text-xs">
            {sessionData.endedAt ? new Date(sessionData.endedAt).toLocaleString() : "—"}
            {sessionData.endReason ? ` (${sessionData.endReason})` : ""}
          </span>
        </Field>
        <Field label={t("fieldReason")} fullSpan>
          <p className="whitespace-pre-wrap text-sm">{sessionData.reason}</p>
        </Field>
      </section>

      <section className="space-y-3">
        <header className="flex items-center justify-between gap-4">
          <h2 className="text-base font-semibold">{t("auditTitle")}</h2>
          <span className="text-xs text-muted-foreground">
            {t("auditCount", { count: auditRows.length })}
          </span>
        </header>
        {auditRows.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface px-6 py-8 text-center text-sm text-muted-foreground">
            {t("auditEmpty")}
          </div>
        ) : (
          <ol className="overflow-hidden rounded-lg border border-border bg-surface">
            {auditRows.map((row) => (
              <li
                key={row.id}
                className="flex flex-col gap-1 border-b border-border px-4 py-3 last:border-b-0 sm:flex-row sm:items-baseline sm:gap-4"
              >
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground sm:w-[180px]">
                  {new Date(row.createdAt).toLocaleString()}
                </span>
                <div className="flex flex-col gap-0.5 text-xs">
                  <code className="font-medium">{row.action}</code>
                  {row.resourceType && (
                    <span className="text-muted-foreground">
                      {row.resourceType}
                      {row.resourceId ? ` · ${row.resourceId}` : ""}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}

function Field({
  label,
  children,
  fullSpan = false,
}: {
  label: string;
  children: React.ReactNode;
  fullSpan?: boolean;
}) {
  return (
    <div className={fullSpan ? "sm:col-span-2" : undefined}>
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

/**
 * Detail-page sibling of the list page's `UserCell`. Renders name +
 * tenant + a small mono UUID side-note. Same fallback ladder: name
 * preferred, then email, then keycloak_id.
 */
function PersonBlock({
  firstName,
  lastName,
  email,
  tenantName,
  tenantSlug,
  keycloakId,
  secondaryLine,
}: {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  tenantName: string | null;
  tenantSlug: string | null;
  keycloakId: string;
  secondaryLine?: string;
}) {
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
  const hasName = fullName.length > 0;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-sm font-medium">
        {hasName ? fullName : (email ?? <code className="font-mono text-xs">{keycloakId}</code>)}
      </span>
      {(email || tenantName || secondaryLine) && (
        <span className="text-xs text-muted-foreground">
          {hasName && email ? email : null}
          {hasName && email && (tenantName || secondaryLine) ? " · " : null}
          {tenantName ? (
            <>
              {tenantName}
              {tenantSlug ? <span className="opacity-60"> ({tenantSlug})</span> : null}
            </>
          ) : null}
          {tenantName && secondaryLine ? " · " : null}
          {secondaryLine ? <span>{secondaryLine}</span> : null}
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
