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
    try {
      const url = await DonationService.getDonationReceiptUrl(createClientApiClient(), donationId);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
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
