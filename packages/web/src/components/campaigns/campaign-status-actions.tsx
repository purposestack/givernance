"use client";

import { Lock, Play, RotateCcw, XCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { ApiProblem } from "@/lib/api";
import { createClientApiClient } from "@/lib/api/client-browser";
import type { CampaignStatus } from "@/models/campaign";
import { CampaignService } from "@/services/CampaignService";

interface CampaignStatusActionsProps {
  campaignId: string;
  status: CampaignStatus;
  /**
   * Status transitions (`PATCH /v1/campaigns/:id` and
   * `POST /v1/campaigns/:id/close`) require `org_admin`. Pass `false` for
   * non-admins so we render a read-only hint instead of buttons that would
   * 403 on click — the StatusCard itself stays visible because the
   * current status is still useful information for everyone.
   */
  canManage: boolean;
}

export function CampaignStatusActions({
  campaignId,
  status,
  canManage,
}: CampaignStatusActionsProps) {
  const router = useRouter();
  const t = useTranslations("campaigns.detail.actions");
  const [pendingAction, setPendingAction] = useState<"activate" | "backToDraft" | "close" | null>(
    null,
  );

  if (!canManage) {
    return (
      <p
        className="flex items-start gap-2 rounded-lg bg-surface-container px-3 py-2 text-sm text-on-surface-variant"
        role="note"
      >
        <Lock size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
        <span>{t("readOnly")}</span>
      </p>
    );
  }

  async function runAction(action: "activate" | "backToDraft" | "close") {
    setPendingAction(action);
    try {
      const client = createClientApiClient();
      if (action === "close") {
        await CampaignService.closeCampaign(client, campaignId);
      } else {
        await CampaignService.updateCampaign(client, campaignId, {
          status: action === "activate" ? "active" : "draft",
        });
      }
      toast.success(t(`success.${action}`));
      router.refresh();
    } catch (err) {
      const message =
        err instanceof ApiProblem ? (err.detail ?? err.title ?? t("error")) : t("error");
      toast.error(message);
    } finally {
      setPendingAction(null);
    }
  }

  const busy = pendingAction !== null;

  return (
    <div className="flex flex-wrap justify-end gap-2">
      <Button onClick={() => void runAction("activate")} disabled={busy || status === "active"}>
        <Play size={16} aria-hidden="true" />
        {pendingAction === "activate" ? t("activating") : t("activate")}
      </Button>
      <Button
        variant="secondary"
        onClick={() => void runAction("backToDraft")}
        disabled={busy || status === "draft" || status === "closed"}
      >
        <RotateCcw size={16} aria-hidden="true" />
        {pendingAction === "backToDraft" ? t("returningToDraft") : t("backToDraft")}
      </Button>
      <Button
        variant="destructive"
        onClick={() => void runAction("close")}
        disabled={busy || status === "closed"}
      >
        <XCircle size={16} aria-hidden="true" />
        {pendingAction === "close" ? t("closing") : t("close")}
      </Button>
    </div>
  );
}
