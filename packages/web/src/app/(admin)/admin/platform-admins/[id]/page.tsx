import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PlatformAdminDetailActions } from "@/components/admin/platform-admin-detail-actions";
import { formatAdminDate } from "@/components/admin/tenant-admin-shared";
import { ApiProblem } from "@/lib/api";
import { createServerApiClient } from "@/lib/api/client-server";
import { requireAuth } from "@/lib/auth/guards";
import type { PlatformAdmin, PlatformAdminDetailResponse } from "@/models/platform-admin";

export const dynamic = "force-dynamic";

export default async function PlatformAdminDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const t = await getTranslations("admin.platformAdmins.detail");
  const api = await createServerApiClient();

  let admin: PlatformAdmin;
  try {
    const res = await api.get<PlatformAdminDetailResponse>(
      `/v1/admin/platform-admins/${encodeURIComponent(id)}`,
    );
    admin = res.data;
  } catch (err) {
    if (err instanceof ApiProblem && err.status === 404) notFound();
    throw err;
  }

  // Operator's Keycloak `sub` — feeds the self-removal hide rule on the
  // remove button. The `(admin)` layout already gates super_admin, so
  // requireAuth() here just resolves the JWT we already verified.
  const operatorAuth = await requireAuth();
  const operatorKeycloakId = operatorAuth.userId;

  return (
    <div className="space-y-8">
      <header>
        <Link
          href="/admin/platform-admins"
          className="text-xs font-medium text-primary hover:underline"
        >
          {t("back")}
        </Link>
        <h1 className="mt-2 font-heading text-2xl text-on-surface">
          {t("title", { firstName: admin.firstName, lastName: admin.lastName })}
        </h1>
        <p className="mt-1 text-sm text-on-surface-variant">
          {admin.deletedAt
            ? t("subtitleRemoved", { date: formatAdminDate(admin.deletedAt) })
            : t("subtitleActive")}
        </p>
      </header>

      <section className="grid grid-cols-1 gap-4 rounded-2xl border border-outline-variant bg-surface p-6 md:grid-cols-2">
        <Field label={t("fields.email")} value={admin.email} />
        <Field label={t("fields.createdAt")} value={formatAdminDate(admin.createdAt)} />
        <Field
          label={t("fields.lastLoginAt")}
          value={
            admin.lastLoginAt ? formatAdminDate(admin.lastLoginAt) : t("fields.lastLoginNever")
          }
        />
        {admin.deletedAt ? (
          <Field label={t("fields.removedAt")} value={formatAdminDate(admin.deletedAt)} />
        ) : (
          <Field label={t("fields.keycloakId")} value={admin.keycloakId ?? "—"} mono />
        )}
      </section>

      <PlatformAdminDetailActions admin={admin} operatorKeycloakId={operatorKeycloakId} />
    </div>
  );
}

function Field({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
        {label}
      </p>
      <p className={`mt-1 text-sm text-on-surface ${mono ? "font-mono" : ""}`}>{value}</p>
    </div>
  );
}
