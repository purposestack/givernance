"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { confirmTenantOwnership } from "@/services/TenantAdminService";

interface TenantOwnershipActionsProps {
  tenantId: string;
  createdVia: string;
  ownershipConfirmedAt: string | null;
}

function normalizeTrack(value: string): string {
  return value.trim().toLowerCase();
}

export function TenantOwnershipActions({
  tenantId,
  createdVia,
  ownershipConfirmedAt,
}: TenantOwnershipActionsProps) {
  const router = useRouter();
  const t = useTranslations("admin.tenants.detail.ownership");
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (normalizeTrack(createdVia) !== "self_serve") return null;

  async function onConfirm() {
    setIsSubmitting(true);
    try {
      await confirmTenantOwnership(tenantId);
      toast.success(t("success"));
      router.refresh();
    } catch {
      toast.error(t("error"));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="rounded-lg border border-outline-variant bg-surface-container-lowest p-4">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold text-text-secondary">{t("title")}</h2>
        <p className="text-sm text-text-muted">
          {ownershipConfirmedAt ? t("confirmedHelp") : t("pendingHelp")}
        </p>
      </div>

      <div className="mt-4">
        <Button
          disabled={Boolean(ownershipConfirmedAt) || isSubmitting}
          onClick={() => void onConfirm()}
        >
          {isSubmitting ? t("submitting") : t("action")}
        </Button>
      </div>
    </section>
  );
}
