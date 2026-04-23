"use client";

import { Download, Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { ApiProblem } from "@/lib/api";
import { createClientApiClient } from "@/lib/api/client-browser";
import { useAuth } from "@/lib/auth";

interface TenantSnapshotResponse {
  data: unknown;
}

interface SettingsSnapshotPanelProps {
  orgId?: string;
  canExport: boolean;
}

function formatSnapshotFilename(orgName: string | undefined, orgId: string) {
  const base = (orgName ?? "organization")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const date = new Date().toISOString().slice(0, 10);

  return `${base || "organization"}-${orgId}-snapshot-${date}.json`;
}

export function SettingsSnapshotPanel({ orgId, canExport }: SettingsSnapshotPanelProps) {
  const t = useTranslations("settings");
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [lastDownloadedAt, setLastDownloadedAt] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const exportEnabled = Boolean(orgId) && canExport;

  async function handleExport() {
    if (!orgId || loading) return;

    setLoading(true);
    setErrorMessage(null);

    try {
      const client = createClientApiClient();
      const response = await client.get<TenantSnapshotResponse>(
        `/v1/admin/tenants/${orgId}/snapshot`,
      );
      const json = JSON.stringify(response.data, null, 2);
      const blob = new Blob([json], { type: "application/json;charset=utf-8" });
      const objectUrl = window.URL.createObjectURL(blob);
      const link = document.createElement("a");

      link.href = objectUrl;
      link.download = formatSnapshotFilename(user?.orgName, orgId);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(objectUrl);

      const downloadedAt = new Date().toLocaleString();
      setLastDownloadedAt(downloadedAt);
      toast.success(t("snapshot.successToast"));
    } catch (err) {
      const message =
        err instanceof ApiProblem
          ? err.detail || t("snapshot.errorProblem", { status: err.status })
          : t("snapshot.errorGeneric");

      setErrorMessage(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="rounded-2xl bg-surface-container-lowest p-5 shadow-card sm:p-6">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-3xl">
          <div className="inline-flex rounded-full bg-surface-container px-3 py-1 text-xs font-medium text-on-surface-variant">
            {t("snapshot.badge")}
          </div>
          <h2 className="mt-4 font-heading text-2xl leading-tight text-on-surface">
            {t("snapshot.title")}
          </h2>
          <p className="mt-2 text-sm leading-6 text-on-surface-variant">
            {t("snapshot.description")}
          </p>
          <p className="mt-4 text-sm text-on-surface-variant">{t("snapshot.help")}</p>

          {lastDownloadedAt ? (
            <p className="mt-3 text-sm text-on-surface-variant">
              {t("snapshot.lastDownloaded", { value: lastDownloadedAt })}
            </p>
          ) : null}

          {errorMessage ? <p className="mt-3 text-sm text-error">{errorMessage}</p> : null}
        </div>

        <div className="flex shrink-0 flex-col items-start gap-3">
          {exportEnabled ? (
            <Button onClick={handleExport} disabled={loading || !orgId}>
              <Download size={16} aria-hidden="true" />
              {loading ? t("snapshot.exportLoading") : t("snapshot.exportCta")}
            </Button>
          ) : (
            <div className="inline-flex items-center gap-2 rounded-xl bg-surface-container px-4 py-3 text-sm text-on-surface-variant">
              <Lock size={16} aria-hidden="true" />
              <span>{t("snapshot.adminOnly")}</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
