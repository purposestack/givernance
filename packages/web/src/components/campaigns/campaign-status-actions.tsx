"use client";

import { Pause, Play, XCircle } from "lucide-react";
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
}

export function CampaignStatusActions({ campaignId, status }: CampaignStatusActionsProps) {
  const router = useRouter();
  const t = useTranslations("campaigns.detail.actions");
  const [pendingAction, setPendingAction] = useState<"activate" | "pause" | "close" | null>(null);

  async function runAction(action: "activate" | "pause" | "close") {
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
    <div className="flex flex-wrap gap-3">
      <Button onClick={() => void runAction("activate")} disabled={busy || status === "active"}>
        <Play size={16} aria-hidden="true" />
        {pendingAction === "activate" ? t("activating") : t("activate")}
      </Button>
      <Button
        variant="secondary"
        onClick={() => void runAction("pause")}
        disabled={busy || status === "draft" || status === "closed"}
      >
        <Pause size={16} aria-hidden="true" />
        {pendingAction === "pause" ? t("pausing") : t("pause")}
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
