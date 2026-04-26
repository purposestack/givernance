import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { FirstAdminCard } from "@/components/admin/first-admin-card";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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

export default async function TenantDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ inviteToken?: string; inviteFailed?: string }>;
}) {
  const { id } = await params;
  const search = await searchParams;
  const t = await getTranslations("admin.tenants.detail");
  const tFirstAdmin = await getTranslations("admin.tenants.detail.firstAdmin");
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

  const { tenant, domains, users, recentAudit, firstAdminInvitation } = detail;

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
      <Table>
        <TableHeader>
          <tr>
            <TableHead>{t("domains.columns.domain")}</TableHead>
            <TableHead>{t("domains.columns.state")}</TableHead>
            <TableHead>{t("domains.columns.dnsTxtValue")}</TableHead>
            <TableHead>{t("domains.columns.verifiedAt")}</TableHead>
          </tr>
        </TableHeader>
        <TableBody>
          {domains.map((domain) => (
            <TableRow key={domain.id}>
              <TableCell>{domain.domain}</TableCell>
              <TableCell>{domain.state}</TableCell>
              <TableCell className="font-mono text-xs text-text-secondary">
                {domain.dnsTxtValue}
              </TableCell>
              <TableCell className="text-text-secondary">
                {formatAdminDate(domain.verifiedAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  ) : (
    <p className="rounded-lg border border-outline-variant bg-surface-container-lowest p-4 text-sm text-text-secondary">
      {t("domains.empty")}
    </p>
  );

  const usersTab = users.length ? (
    <div className="overflow-hidden rounded-lg border border-outline-variant bg-surface-container-lowest">
      <Table>
        <TableHeader>
          <tr>
            <TableHead>{t("users.columns.name")}</TableHead>
            <TableHead>{t("users.columns.email")}</TableHead>
            <TableHead>{t("users.columns.role")}</TableHead>
            <TableHead>{t("users.columns.flags")}</TableHead>
            <TableHead>{t("users.columns.lastVisitedAt")}</TableHead>
          </tr>
        </TableHeader>
        <TableBody>
          {users.map((user) => (
            <TableRow key={user.id}>
              <TableCell>{formatTenantUserName(user.firstName, user.lastName)}</TableCell>
              <TableCell className="text-text-secondary">{user.email}</TableCell>
              <TableCell>{user.role}</TableCell>
              <TableCell className="text-text-secondary">
                {user.firstAdmin
                  ? t("users.flags.firstAdmin")
                  : user.provisionalUntil
                    ? t("users.flags.provisionalUntil", {
                        date: formatAdminDate(user.provisionalUntil),
                      })
                    : "—"}
              </TableCell>
              <TableCell className="text-text-secondary">
                {formatAdminDate(user.lastVisitedAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  ) : (
    <p className="rounded-lg border border-outline-variant bg-surface-container-lowest p-4 text-sm text-text-secondary">
      {t("users.empty")}
    </p>
  );

  const auditTab = recentAudit.length ? (
    <div className="overflow-hidden rounded-lg border border-outline-variant bg-surface-container-lowest">
      <Table>
        <TableHeader>
          <tr>
            <TableHead>{t("audit.columns.createdAt")}</TableHead>
            <TableHead>{t("audit.columns.action")}</TableHead>
            <TableHead>{t("audit.columns.resource")}</TableHead>
            <TableHead>{t("audit.columns.actor")}</TableHead>
            <TableHead>{t("audit.columns.changes")}</TableHead>
          </tr>
        </TableHeader>
        <TableBody>
          {recentAudit.map((entry) => (
            <TableRow key={entry.id} className="align-top">
              <TableCell className="text-text-secondary">
                {formatAdminDate(entry.createdAt)}
              </TableCell>
              <TableCell>{entry.action}</TableCell>
              <TableCell className="text-text-secondary">
                {[entry.resourceType, entry.resourceId].filter(Boolean).join(" · ") || "—"}
              </TableCell>
              <TableCell className="font-mono text-xs text-text-secondary">
                {entry.userId ?? "—"}
              </TableCell>
              <TableCell className="text-xs text-text-secondary">
                <p>{t("audit.oldValues", { value: renderJsonPreview(entry.oldValues) })}</p>
                <p className="mt-1">
                  {t("audit.newValues", { value: renderJsonPreview(entry.newValues) })}
                </p>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
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

      <FirstAdminCard
        tenantId={tenant.id}
        invitation={firstAdminInvitation}
        initialFreshToken={search.inviteToken}
        initialError={
          search.inviteFailed === "1" ? tFirstAdmin("errors.formInviteFailed") : undefined
        }
      />

      <TenantDetailTabs
        overview={overview}
        domains={domainsTab}
        users={usersTab}
        audit={auditTab}
      />
    </div>
  );
}
