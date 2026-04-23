import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  formatAdminDate,
  formatTenantUserName,
  normalizeTenantToken,
  renderJsonPreview,
  TenantStatusBadge,
  TenantVerificationBadge,
} from "@/components/admin/tenant-admin-shared";
import { TenantDetailTabs } from "@/components/admin/tenant-detail-tabs";
import { TenantLifecycleActions } from "@/components/admin/tenant-lifecycle-actions";
import { createServerApiClient } from "@/lib/api/client-server";
import type { AdminTenantDetailResponse } from "@/services/TenantAdminService";

export const dynamic = "force-dynamic";

function DetailCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-outline-variant bg-surface-container-lowest p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">{label}</p>
      <p className="mt-2 text-sm text-text">{value}</p>
    </div>
  );
}

function tenantStatusLabel(
  t: (key: "statuses.active" | "statuses.suspended" | "statuses.archived") => string,
  status: string,
): string {
  const normalized = normalizeTenantToken(status);
  if (normalized === "active") return t("statuses.active");
  if (normalized === "suspended") return t("statuses.suspended");
  if (normalized === "archived") return t("statuses.archived");
  return status;
}

export default async function TenantDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const t = await getTranslations("admin.tenants.detail");
  const api = await createServerApiClient();

  let detail: AdminTenantDetailResponse["data"] | null = null;
  try {
    const res = await api.get<AdminTenantDetailResponse>(
      `/v1/superadmin/tenants/${encodeURIComponent(id)}/detail`,
    );
    detail = res.data;
  } catch {
    notFound();
  }

  if (!detail) notFound();

  const { tenant, domains, users, recentAudit } = detail;

  const overview = (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      <DetailCard label={t("overview.fields.slug")} value={tenant.slug} />
      <DetailCard label={t("overview.fields.plan")} value={tenant.plan} />
      <DetailCard label={t("overview.fields.createdVia")} value={tenant.createdVia} />
      <DetailCard label={t("overview.fields.primaryDomain")} value={tenant.primaryDomain ?? "—"} />
      <DetailCard label={t("overview.fields.keycloakOrgId")} value={tenant.keycloakOrgId ?? "—"} />
      <DetailCard
        label={t("overview.fields.createdAt")}
        value={formatAdminDate(tenant.createdAt)}
      />
      <DetailCard
        label={t("overview.fields.updatedAt")}
        value={formatAdminDate(tenant.updatedAt)}
      />
      <DetailCard
        label={t("overview.fields.verifiedAt")}
        value={tenant.verifiedAt ? formatAdminDate(tenant.verifiedAt) : "—"}
      />
    </div>
  );

  const domainsTab = domains.length ? (
    <div className="overflow-hidden rounded-lg border border-outline-variant bg-surface-container-lowest">
      <table className="w-full border-separate border-spacing-0 text-left text-sm">
        <thead className="bg-surface-container-low text-xs uppercase tracking-wide text-text-secondary">
          <tr>
            <th className="px-4 py-3">{t("domains.columns.domain")}</th>
            <th className="px-4 py-3">{t("domains.columns.state")}</th>
            <th className="px-4 py-3">{t("domains.columns.dnsTxtValue")}</th>
            <th className="px-4 py-3">{t("domains.columns.verifiedAt")}</th>
          </tr>
        </thead>
        <tbody>
          {domains.map((domain) => (
            <tr key={domain.id} className="border-t border-outline-variant">
              <td className="px-4 py-3 text-text">{domain.domain}</td>
              <td className="px-4 py-3 text-text">{domain.state}</td>
              <td className="px-4 py-3 font-mono text-xs text-text-secondary">
                {domain.dnsTxtValue}
              </td>
              <td className="px-4 py-3 text-text-secondary">
                {formatAdminDate(domain.verifiedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <p className="rounded-lg border border-outline-variant bg-surface-container-lowest p-4 text-sm text-text-secondary">
      {t("domains.empty")}
    </p>
  );

  const usersTab = users.length ? (
    <div className="overflow-hidden rounded-lg border border-outline-variant bg-surface-container-lowest">
      <table className="w-full border-separate border-spacing-0 text-left text-sm">
        <thead className="bg-surface-container-low text-xs uppercase tracking-wide text-text-secondary">
          <tr>
            <th className="px-4 py-3">{t("users.columns.name")}</th>
            <th className="px-4 py-3">{t("users.columns.email")}</th>
            <th className="px-4 py-3">{t("users.columns.role")}</th>
            <th className="px-4 py-3">{t("users.columns.flags")}</th>
            <th className="px-4 py-3">{t("users.columns.lastVisitedAt")}</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id} className="border-t border-outline-variant">
              <td className="px-4 py-3 text-text">
                {formatTenantUserName(user.firstName, user.lastName)}
              </td>
              <td className="px-4 py-3 text-text-secondary">{user.email}</td>
              <td className="px-4 py-3 text-text">{user.role}</td>
              <td className="px-4 py-3 text-text-secondary">
                {user.firstAdmin
                  ? t("users.flags.firstAdmin")
                  : user.provisionalUntil
                    ? t("users.flags.provisionalUntil", {
                        date: formatAdminDate(user.provisionalUntil),
                      })
                    : "—"}
              </td>
              <td className="px-4 py-3 text-text-secondary">
                {formatAdminDate(user.lastVisitedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <p className="rounded-lg border border-outline-variant bg-surface-container-lowest p-4 text-sm text-text-secondary">
      {t("users.empty")}
    </p>
  );

  const auditTab = recentAudit.length ? (
    <div className="overflow-hidden rounded-lg border border-outline-variant bg-surface-container-lowest">
      <table className="w-full border-separate border-spacing-0 text-left text-sm">
        <thead className="bg-surface-container-low text-xs uppercase tracking-wide text-text-secondary">
          <tr>
            <th className="px-4 py-3">{t("audit.columns.createdAt")}</th>
            <th className="px-4 py-3">{t("audit.columns.action")}</th>
            <th className="px-4 py-3">{t("audit.columns.resource")}</th>
            <th className="px-4 py-3">{t("audit.columns.actor")}</th>
            <th className="px-4 py-3">{t("audit.columns.changes")}</th>
          </tr>
        </thead>
        <tbody>
          {recentAudit.map((entry) => (
            <tr key={entry.id} className="border-t border-outline-variant align-top">
              <td className="px-4 py-3 text-text-secondary">{formatAdminDate(entry.createdAt)}</td>
              <td className="px-4 py-3 text-text">{entry.action}</td>
              <td className="px-4 py-3 text-text-secondary">
                {[entry.resourceType, entry.resourceId].filter(Boolean).join(" · ") || "—"}
              </td>
              <td className="px-4 py-3 font-mono text-xs text-text-secondary">
                {entry.userId ?? "—"}
              </td>
              <td className="px-4 py-3 text-xs text-text-secondary">
                <p>{t("audit.oldValues", { value: renderJsonPreview(entry.oldValues) })}</p>
                <p className="mt-1">
                  {t("audit.newValues", { value: renderJsonPreview(entry.newValues) })}
                </p>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <p className="rounded-lg border border-outline-variant bg-surface-container-lowest p-4 text-sm text-text-secondary">
      {t("audit.empty")}
    </p>
  );

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <Link href="/admin/tenants" className="text-xs text-primary hover:underline">
          ← {t("backToList")}
        </Link>
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div>
            <h1 className="font-heading text-2xl text-text">{tenant.name}</h1>
            <p className="mt-1 text-sm text-text-secondary">{tenant.slug}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <TenantStatusBadge status={tenant.status} label={tenantStatusLabel(t, tenant.status)} />
            <TenantVerificationBadge
              verifiedAt={tenant.verifiedAt}
              verifiedLabel={t("verification.verified")}
              pendingLabel={t("verification.pending")}
            />
          </div>
        </div>
      </header>

      <TenantLifecycleActions tenantId={tenant.id} currentStatus={tenant.status} />

      <TenantDetailTabs
        overview={overview}
        domains={domainsTab}
        users={usersTab}
        audit={auditTab}
      />
    </div>
  );
}
