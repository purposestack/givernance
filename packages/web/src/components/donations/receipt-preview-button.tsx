"use client";

import { Receipt } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { ApiProblem } from "@/lib/api";
import { createClientApiClient } from "@/lib/api/client-browser";
import { DonationService } from "@/services/DonationService";

interface ReceiptPreviewButtonProps {
  donationId: string;
}

export function ReceiptPreviewButton({ donationId }: ReceiptPreviewButtonProps) {
  const t = useTranslations("donations.detail");
  const [loading, setLoading] = useState(false);

  async function handlePreview() {
    if (loading) return;
    setLoading(true);
    // Open the download tab synchronously so the click is in the same
    // event-loop tick as the user gesture — Safari + Firefox block
    // popups opened after an `await`. We redirect the placeholder tab
    // to the resolved URL once the metadata fetch resolves.
    const popup = window.open("about:blank", "_blank", "noopener,noreferrer");
    try {
      // The service resolves the absolute browser URL (NEXT_PUBLIC_API_URL
      // + downloadPath) so this component never reconstructs the API
      // base — preserves the URL-consistency rule (issue #214) without
      // hardcoding `/api`.
      const url = await DonationService.getDonationReceiptDownloadUrl(
        createClientApiClient(),
        donationId,
      );
      if (popup) {
        popup.location.href = url;
      } else {
        // Popup blocker fired — surface the failure instead of leaving
        // the user with no signal that anything went wrong.
        toast.error(t("receipt.error"));
      }
    } catch (err) {
      popup?.close();
      if (err instanceof ApiProblem && err.status === 404) {
        toast.warning(t("receipt.pending"));
      } else {
        toast.error(t("receipt.error"));
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button type="button" variant="secondary" size="sm" onClick={handlePreview} disabled={loading}>
      <Receipt size={16} aria-hidden="true" />
      {loading ? t("actions.generatingReceipt") : t("actions.previewReceipt")}
    </Button>
  );
}
