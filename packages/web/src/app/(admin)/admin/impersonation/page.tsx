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

/**
 * Active support sessions list (issue #24).
 *
 * Shows the currently-running delegation/impersonation sessions across the
 * platform. End/revoke actions live on the row; starting a new session
 * goes through `/admin/impersonation/new`.
 */
export default async function ImpersonationListPage() {
  const t = await getTranslations("admin.impersonation");
  const client = await createServerApiClient();
  const { data } = await ImpersonationService.listSessions(client, { all: false });

  return (
    <main id="main-content" className="mx-auto max-w-6xl space-y-6 p-6">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{t("listTitle")}</h1>
          <p className="text-sm text-muted-foreground">{t("listSubtitle")}</p>
        </div>
        <Button asChild>
          <Link href="/admin/impersonation/new">{t("startNew")}</Link>
        </Button>
      </header>

      {data.length === 0 ? (
        <div className="rounded-lg border border-border bg-surface px-6 py-10 text-center text-sm text-muted-foreground">
          {t("emptyState")}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-surface">
          <table className="min-w-full text-sm">
            <thead className="bg-surface-variant text-left text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-4 py-3">{t("colMode")}</th>
                <th className="px-4 py-3">{t("colTarget")}</th>
                <th className="px-4 py-3">{t("colImpersonator")}</th>
                <th className="px-4 py-3">{t("colReason")}</th>
                <th className="px-4 py-3">{t("colExpires")}</th>
                <th className="px-4 py-3 text-right">{t("colActions")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.map((session) => (
                <SessionRow key={session.id} session={session} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

async function SessionRow({ session }: { session: ImpersonationSessionDTO }) {
  const t = await getTranslations("admin.impersonation");
  const isPure = session.mode === "impersonation";
  const modeBadgeClass = isPure
    ? "rounded bg-error-light px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-error-text"
    : "rounded bg-amber-light px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-amber-text";
  return (
    <tr>
      <td className="px-4 py-3">
        <span className={modeBadgeClass}>
          {isPure ? t("badgeImpersonation") : t("badgeDelegation")}
        </span>
      </td>
      <td className="px-4 py-3 font-mono text-xs">{session.targetKeycloakId}</td>
      <td className="px-4 py-3 font-mono text-xs">{session.impersonatorKeycloakId}</td>
      <td className="px-4 py-3 text-xs">{session.reason}</td>
      <td className="px-4 py-3 text-xs">{new Date(session.expiresAt).toLocaleString()}</td>
      <td className="px-4 py-3 text-right">
        <EndImpersonationSessionButton sessionId={session.id} />
      </td>
    </tr>
  );
}
