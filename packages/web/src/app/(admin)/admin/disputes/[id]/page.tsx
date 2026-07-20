import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import type { CSSProperties } from "react";
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

  function resolutionLabel(resolution: string | null): string {
    if (resolution === "replaced") return t("resolutions.replaced");
    if (resolution === "escalated_to_support") return t("resolutions.escalated_to_support");
    return t("resolutions.kept");
  }

  return (
    <div className="max-w-2xl space-y-6">
      <header>
        <Link href="/admin/disputes" className="text-xs text-primary hover:underline">
          ← {t("backToList")}
        </Link>
        <h1 className="mt-2 font-heading text-2xl text-on-surface">
          {t("title", { name: row.orgName })}
        </h1>
        <p className="mt-1 text-sm text-on-surface-variant">
          {row.orgSlug} · {new Date(row.createdAt).toLocaleString()}
        </p>
      </header>

      {/* ADR-035 rules A1/A2 — the header above is static shell; the
          content sections cascade in reading order (slots 0-2). The
          resolve form enters as ONE block (rule E19). */}
      <section className="reveal-item rounded-lg border border-outline-variant bg-surface-container-lowest p-4">
        <h2 className="text-sm font-semibold text-on-surface-variant">{t("reasonLabel")}</h2>
        <p className="mt-2 whitespace-pre-wrap text-sm text-on-surface">
          {row.reason ?? t("noReason")}
        </p>
      </section>

      <section
        className="reveal-item rounded-lg border border-outline-variant bg-surface-container-lowest p-4"
        style={{ "--cascade-i": 1 } as CSSProperties}
      >
        <h2 className="text-sm font-semibold text-on-surface-variant">{t("partiesLabel")}</h2>
        <dl className="mt-2 grid gap-2 text-sm text-on-surface">
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
        <section
          className="reveal-item rounded-lg border border-outline-variant bg-surface-container-lowest p-4"
          style={{ "--cascade-i": 2 } as CSSProperties}
        >
          <h2 className="text-sm font-semibold text-on-surface-variant">{t("resolvedLabel")}</h2>
          <p className="mt-2 text-sm text-on-surface">
            {resolutionLabel(row.resolution)} —{" "}
            {row.resolvedAt ? new Date(row.resolvedAt).toLocaleString() : ""}
          </p>
        </section>
      ) : (
        <div className="reveal-item" style={{ "--cascade-i": 2 } as CSSProperties}>
          <DisputeResolveForm disputeId={row.id} />
        </div>
      )}
    </div>
  );
}
