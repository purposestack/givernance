"use client";

import { Trash2 } from "lucide-react";
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

interface DeleteDonationButtonProps {
  donationId: string;
  /**
   * Donor display name interpolated into the confirm dialog. Falls back
   * to the generic copy when null (e.g. anonymous donations).
   */
  donorName: string | null;
}

/**
 * Detail-page Delete affordance — mirrors the row-level Delete in
 * `donations-table.tsx` (same `DonationService.deleteDonation` call,
 * same AlertDialog confirmation copy from the `donations.*` namespace).
 *
 * On success we navigate back to `/donations` rather than `router.refresh()`
 * because the entity the current route resolves no longer exists; staying
 * on `/donations/[id]` would re-fetch and 404.
 */
export function DeleteDonationButton({ donationId, donorName }: DeleteDonationButtonProps) {
  const router = useRouter();
  const t = useTranslations("donations");
  const tDetail = useTranslations("donations.detail.actions");
  const [open, setOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  async function confirmDelete() {
    setIsDeleting(true);
    try {
      await DonationService.deleteDonation(createClientApiClient(), donationId);
      toast.success(t("success.deleted"));
      // Replace (not push) so the back button doesn't return to the now-gone
      // detail page.
      router.replace("/donations");
      router.refresh();
    } catch (err) {
      if (!(err instanceof ApiProblem)) console.error("donation.delete failed", err);
      const message =
        err instanceof ApiProblem
          ? (err.detail ?? err.title ?? t("errors.deleteGeneric"))
          : t("errors.deleteGeneric");
      toast.error(message);
      setIsDeleting(false);
    }
  }

  return (
    <>
      <Button variant="destructive" size="sm" onClick={() => setOpen(true)}>
        <Trash2 size={16} aria-hidden="true" />
        {tDetail("delete")}
      </Button>

      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          if (!isDeleting) setOpen(next);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteDialog.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {donorName
                ? t("deleteDialog.description", { name: donorName })
                : t("deleteDialog.descriptionFallback")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button variant="ghost" disabled={isDeleting}>
                {t("deleteDialog.cancel")}
              </Button>
            </AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={isDeleting}
              onClick={() => void confirmDelete()}
            >
              {isDeleting ? t("deleteDialog.deleting") : t("deleteDialog.confirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
