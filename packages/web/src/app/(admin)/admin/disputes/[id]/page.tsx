import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { DisputeResolveForm } from "@/components/admin/dispute-resolve-form";
import { createServerApiClient } from "@/lib/api/client-server";
import type { DisputeRow } from "@/services/DisputesService";

export const dynamic = "force-dynamic";

export default async function DisputeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = await getTranslations("admin.disputes.detail");
  const api = await createServerApiClient();

  let row: DisputeRow | null = null;
  try {
    const res = await api.get<{ data: DisputeRow }>(`/v1/admin/disputes/${encodeURIComponent(id)}`);
    row = res.data;
  } catch {
    notFound();
  }
  if (!row) notFound();

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
            <dt className="text-text-muted">{t("disputer")}</dt>
            <dd className="font-mono text-xs">{row.disputerId ?? "—"}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-text-muted">{t("provisionalAdmin")}</dt>
            <dd className="font-mono text-xs">{row.provisionalAdminId ?? "—"}</dd>
          </div>
        </dl>
      </section>

      {row.resolution ? (
        <section className="rounded-lg border border-outline-variant bg-surface-container-lowest p-4">
          <h2 className="text-sm font-semibold text-text-secondary">{t("resolvedLabel")}</h2>
          <p className="mt-2 text-sm text-text">
            {row.resolution === "replaced"
              ? t("resolutions.replaced")
              : row.resolution === "escalated_to_support"
                ? t("resolutions.escalated_to_support")
                : t("resolutions.kept")}{" "}
            — {row.resolvedAt ? new Date(row.resolvedAt).toLocaleString() : ""}
          </p>
        </section>
      ) : (
        <DisputeResolveForm disputeId={row.id} />
      )}
    </div>
  );
}
