"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { type TenantLifecycleAction, triggerTenantLifecycle } from "@/services/TenantAdminService";

interface TenantLifecycleActionsProps {
  tenantId: string;
  currentStatus: string;
}

function normalizeStatus(status: string): string {
  return status.trim().toLowerCase();
}

export function TenantLifecycleActions({ tenantId, currentStatus }: TenantLifecycleActionsProps) {
  const router = useRouter();
  const t = useTranslations("admin.tenants.detail.lifecycle");
  const [reason, setReason] = useState("");
  const [pendingAction, setPendingAction] = useState<TenantLifecycleAction | null>(null);

  const allowedActions = useMemo(() => {
    const normalized = normalizeStatus(currentStatus);
    return {
      suspend: normalized !== "suspended" && normalized !== "archived",
      archive: normalized !== "archived",
      activate: normalized !== "active",
    };
  }, [currentStatus]);

  async function onAction(action: TenantLifecycleAction) {
    setPendingAction(action);
    try {
      await triggerTenantLifecycle(tenantId, action, reason);
      toast.success(t("success", { action }));
      setReason("");
      router.refresh();
    } catch {
      toast.error(t("error"));
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <section className="rounded-lg border border-outline-variant bg-surface-container-lowest p-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold text-text-secondary">{t("title")}</h2>
        <p className="text-sm text-text-muted">{t("description")}</p>
      </div>

      <div className="mt-4 space-y-4">
        <div className="space-y-2">
          <label htmlFor="tenant-lifecycle-reason" className="text-sm font-medium text-text">
            {t("reasonLabel")}
          </label>
          <textarea
            id="tenant-lifecycle-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={t("reasonPlaceholder")}
            rows={3}
            className="w-full rounded-md border border-outline-variant bg-surface px-3 py-2 text-sm text-text outline-none transition-colors duration-normal ease-out placeholder:text-text-muted focus:border-primary"
          />
        </div>

        <div className="flex flex-wrap gap-3">
          <Button
            variant="secondary"
            disabled={!allowedActions.suspend || pendingAction !== null}
            onClick={() => void onAction("suspend")}
          >
            {pendingAction === "suspend" ? t("submitting") : t("actions.suspend")}
          </Button>
          <Button
            variant="destructive"
            disabled={!allowedActions.archive || pendingAction !== null}
            onClick={() => void onAction("archive")}
          >
            {pendingAction === "archive" ? t("submitting") : t("actions.archive")}
          </Button>
          <Button
            disabled={!allowedActions.activate || pendingAction !== null}
            onClick={() => void onAction("activate")}
          >
            {pendingAction === "activate" ? t("submitting") : t("actions.activate")}
          </Button>
        </div>
      </div>
    </section>
  );
}
