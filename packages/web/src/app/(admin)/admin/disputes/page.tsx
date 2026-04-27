import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { createServerApiClient } from "@/lib/api/client-server";
import type { DisputeRow, DomainDisputeRow } from "@/services/DisputesService";

export const dynamic = "force-dynamic";

/**
 * Back-office dispute queue (issue #113 / doc 22 §4.3).
 *
 * Super-admin list of every open and recently-resolved dispute. Open rows
 * are surfaced first; resolved rows are shown below with their resolution
 * badge so support can audit outcomes.
 */
export default async function DisputeListPage() {
  const t = await getTranslations("admin.disputes.list");
  const api = await createServerApiClient();

  let rows: DisputeRow[] = [];
  let domainRows: DomainDisputeRow[] = [];
  try {
    const [res, domainRes] = await Promise.all([
      api.get<{ data: DisputeRow[] }>("/v1/admin/disputes"),
      api.get<{ data: DomainDisputeRow[] }>("/v1/admin/domain-disputes"),
    ]);
    rows = res.data;
    domainRows = domainRes.data;
  } catch {
    // surfaced via empty state below
  }

  const open = rows.filter((r) => r.resolution === null);
  const closed = rows.filter((r) => r.resolution !== null);
  const domainOpen = domainRows.filter((r) => r.state === "open");

  function resolutionLabel(resolution: string | null): string {
    if (resolution === "replaced") return t("resolutions.replaced");
    if (resolution === "escalated_to_support") return t("resolutions.escalated_to_support");
    return t("resolutions.kept");
  }

  return (
    <div className="space-y-8">
      <header>
        <h1 className="font-heading text-2xl text-text">{t("title")}</h1>
        <p className="mt-1 text-sm text-text-secondary">{t("subtitle")}</p>
      </header>

      <section aria-labelledby="open-disputes-title">
        <h2
          id="open-disputes-title"
          className="mb-3 text-sm font-semibold uppercase tracking-wide text-text-secondary"
        >
          {t("openSectionTitle", { count: open.length })}
        </h2>
        {open.length === 0 ? (
          <p className="rounded-md border border-outline-variant bg-surface-container-lowest p-4 text-sm text-text-secondary">
            {t("emptyOpen")}
          </p>
        ) : (
          <ul className="space-y-2">
            {open.map((row) => (
              <li key={row.id}>
                <Link
                  href={`/admin/disputes/${row.id}`}
                  className="block rounded-lg border border-outline-variant bg-surface-container-lowest p-4 transition-colors duration-normal ease-out hover:border-primary"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-text">{row.orgName}</p>
                      <p className="text-xs text-text-muted">
                        {row.orgSlug} · {new Date(row.createdAt).toLocaleString()}
                      </p>
                    </div>
                    <span className="rounded-full bg-amber-light px-2 py-0.5 text-xs font-medium text-amber-text">
                      {t("pending")}
                    </span>
                  </div>
                  {row.reason && (
                    <p className="mt-2 line-clamp-2 text-sm text-text-secondary">{row.reason}</p>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="domain-disputes-title">
        <h2
          id="domain-disputes-title"
          className="mb-3 mt-12 text-sm font-semibold uppercase tracking-wide text-text-secondary"
        >
          {t("domainSectionTitle", { count: domainOpen.length })}
        </h2>
        {domainOpen.length === 0 ? (
          <p className="rounded-md border border-outline-variant bg-surface-container-lowest p-4 text-sm text-text-secondary">
            {t("emptyDomain")}
          </p>
        ) : (
          <ul className="space-y-2">
            {domainOpen.map((row) => (
              <li key={row.id}>
                <Link
                  href={`/admin/domain-disputes/${row.id}`}
                  className="block rounded-lg border border-outline-variant bg-surface-container-lowest p-4 transition-colors duration-normal ease-out hover:border-primary"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-text">{row.claimerEmail}</p>
                      <p className="text-xs text-text-muted">
                        Disputing {row.orgName} ({row.orgSlug}) ·{" "}
                        {new Date(row.createdAt).toLocaleString()}
                      </p>
                    </div>
                    <span className="rounded-full bg-amber-light px-2 py-0.5 text-xs font-medium text-amber-text">
                      {t("pending")}
                    </span>
                  </div>
                  {row.reason && (
                    <p className="mt-2 line-clamp-2 text-sm text-text-secondary">{row.reason}</p>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="closed-disputes-title">
        <h2
          id="closed-disputes-title"
          className="mb-3 text-sm font-semibold uppercase tracking-wide text-text-secondary"
        >
          {t("closedSectionTitle", { count: closed.length })}
        </h2>
        {closed.length === 0 ? (
          <p className="rounded-md border border-outline-variant bg-surface-container-lowest p-4 text-sm text-text-secondary">
            {t("emptyClosed")}
          </p>
        ) : (
          <ul className="space-y-2">
            {closed.slice(0, 50).map((row) => (
              <li key={row.id}>
                <Link
                  href={`/admin/disputes/${row.id}`}
                  className="block rounded-lg border border-outline-variant bg-surface-container-lowest p-4 transition-colors duration-normal ease-out hover:border-primary"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-text">{row.orgName}</p>
                      <p className="text-xs text-text-muted">
                        {row.orgSlug} ·{" "}
                        {row.resolvedAt ? new Date(row.resolvedAt).toLocaleString() : ""}
                      </p>
                    </div>
                    <span className="rounded-full bg-surface-container-low px-2 py-0.5 text-xs font-medium text-text-secondary">
                      {resolutionLabel(row.resolution)}
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
