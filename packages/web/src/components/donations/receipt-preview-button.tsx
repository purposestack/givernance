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
      // `downloadPath` is a same-origin API path (e.g.
      // `/v1/donations/<id>/receipt/download`); next.config rewrites
      // `/api/v1/*` to the API service. We prefix with `/api` so the
      // request hits the same Next.js rewrite the rest of the SPA uses,
      // keeping the donor on `staging.givernance.org` (issue #214).
      const downloadPath = await DonationService.getDonationReceiptDownloadPath(
        createClientApiClient(),
        donationId,
      );
      window.open(`/api${downloadPath}`, "_blank", "noopener,noreferrer");
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
