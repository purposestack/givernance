import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { createServerApiClient } from "@/lib/api/client-server";
import type { DomainDisputeRow } from "@/services/DisputesService";

export const dynamic = "force-dynamic";

export default async function DomainDisputeDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const t = await getTranslations("admin.disputes.detail");
  const api = await createServerApiClient();

  const tList = await getTranslations("admin.disputes.list");

  let row: DomainDisputeRow | null = null;
  try {
    const res = await api.get<{ data: DomainDisputeRow }>(
      `/v1/admin/domain-disputes/${encodeURIComponent(id)}`,
    );
    row = res.data;
  } catch {
    notFound();
  }
  if (!row) notFound();

  function resolutionLabel(state: string | null): string {
    if (state === "resolved_kept") return tList("resolutions.resolved_kept");
    if (state === "resolved_transferred") return tList("resolutions.resolved_transferred");
    if (state === "rejected") return tList("resolutions.rejected");
    return state || "";
  }

  return (
    <div className="max-w-2xl space-y-6">
      <header>
        <Link href="/admin/disputes" className="text-xs text-primary hover:underline">
          ← {t("backToList")}
        </Link>
        <h1 className="mt-2 font-heading text-2xl text-text">
          {t("title", { name: row.orgName })}
        </h1>
        <p className="mt-1 text-sm text-text-secondary">
          {row.orgSlug} · {new Date(row.createdAt).toLocaleString()}
        </p>
      </header>

      <section className="rounded-lg border border-outline-variant bg-surface-container-lowest p-4">
        <h2 className="text-sm font-semibold text-text-secondary">{t("reasonLabel")}</h2>
        <p className="mt-2 whitespace-pre-wrap text-sm text-text">{row.reason ?? t("noReason")}</p>
      </section>

      <section className="rounded-lg border border-outline-variant bg-surface-container-lowest p-4">
        <h2 className="text-sm font-semibold text-text-secondary">{t("partiesLabel")}</h2>
        <dl className="mt-2 grid gap-2 text-sm text-text">
          <div className="flex justify-between">
            <dt className="text-text-muted">Claimer Email</dt>
            <dd className="font-mono text-xs">{row.claimerEmail ?? "—"}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-text-muted">Tenant disputed</dt>
            <dd className="font-mono text-xs">{row.orgSlug ?? "—"}</dd>
          </div>
        </dl>
      </section>

      {row.state !== "open" ? (
        <section className="rounded-lg border border-outline-variant bg-surface-container-lowest p-4">
          <h2 className="text-sm font-semibold text-text-secondary">{t("resolvedLabel")}</h2>
          <p className="mt-2 text-sm text-text">
            {resolutionLabel(row.state)} —{" "}
            {row.resolvedAt ? new Date(row.resolvedAt).toLocaleString() : ""}
          </p>
        </section>
      ) : (
        <p className="text-sm text-text-secondary">
          Resolution options via UI not yet implemented. Use API to resolve.
        </p>
      )}
    </div>
  );
}
