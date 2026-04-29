"use client";

import { Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { ApiProblem } from "@/lib/api";
import { createClientApiClient } from "@/lib/api/client-browser";
import { DonationService } from "@/services/DonationService";

interface RefundDonationButtonProps {
  donationId: string;
  /**
   * Localised amount label interpolated into the confirm dialog
   * ("Refund €50.00 to Jane Doe?"). Pre-formatted at the server layer
   * so we don't re-derive it client-side.
   */
  amountLabel: string;
  /** Donor display name; falls back to a generic copy when null. */
  donorName: string | null;
}

/**
 * Refund a Stripe donation via `POST /v1/donations/:id/refund`. Org-admin
 * only — guarded both client-side (rendered behind `hasPermission(auth,
 * "admin")` on the detail page) and server-side (`requireOrgAdmin`).
 *
 * On success we `router.refresh()` so the donation status badge flips
 * to "refunded" without a full reload. The Stripe-side rollback of the
 * application fee is handled by the route's `refund_application_fee:
 * true` flag (issue #199 / docs/payments-overview.md).
 */
export function RefundDonationButton({
  donationId,
  amountLabel,
  donorName,
}: RefundDonationButtonProps) {
  const router = useRouter();
  const t = useTranslations("donations");
  const tDetail = useTranslations("donations.detail.actions");
  const [open, setOpen] = useState(false);
  const [isRefunding, setIsRefunding] = useState(false);

  async function confirmRefund() {
    setIsRefunding(true);
    try {
      await DonationService.refundDonation(createClientApiClient(), donationId);
      toast.success(t("success.refunded"));
      setOpen(false);
      router.refresh();
    } catch (err) {
      if (!(err instanceof ApiProblem)) console.error("donation.refund failed", err);
      const message =
        err instanceof ApiProblem
          ? (err.detail ?? err.title ?? t("errors.refundGeneric"))
          : t("errors.refundGeneric");
      toast.error(message);
    } finally {
      setIsRefunding(false);
    }
  }

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <Undo2 size={16} aria-hidden="true" />
        {tDetail("refund")}
      </Button>

      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!isRefunding) setOpen(next);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("refundDialog.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {donorName
                ? t("refundDialog.description", { amount: amountLabel, name: donorName })
                : t("refundDialog.descriptionFallback", { amount: amountLabel })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <p className="px-6 pb-2 text-xs text-on-surface-variant">{t("refundDialog.hint")}</p>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button variant="ghost" disabled={isRefunding}>
                {t("refundDialog.cancel")}
              </Button>
            </AlertDialogCancel>
            <Button variant="secondary" disabled={isRefunding} onClick={() => void confirmRefund()}>
              {isRefunding ? t("refundDialog.refunding") : t("refundDialog.confirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
