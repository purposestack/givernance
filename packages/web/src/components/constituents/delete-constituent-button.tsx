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
import { ConstituentService } from "@/services/ConstituentService";

interface DeleteConstituentButtonProps {
  constituentId: string;
  /** Display name interpolated into the confirm dialog. */
  constituentName: string;
}

/**
 * Profile-header Delete affordance (issue #614) — mirrors the row-level
 * Delete in `constituents-table.tsx` (same `ConstituentService.deleteConstituent`
 * soft-delete call, same AlertDialog confirmation copy from the
 * `constituents.*` namespace). Rendered for `org_admin` only — the route is
 * `requireOrgAdmin`.
 *
 * On success we navigate back to `/constituents` rather than
 * `router.refresh()` because the entity the current route resolves no longer
 * exists; staying on `/constituents/[id]` would re-fetch and 404.
 */
export function DeleteConstituentButton({
  constituentId,
  constituentName,
}: DeleteConstituentButtonProps) {
  const router = useRouter();
  const t = useTranslations("constituents");
  const tDetail = useTranslations("constituentDetail.actions");
  const [open, setOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  async function confirmDelete() {
    setIsDeleting(true);
    try {
      await ConstituentService.deleteConstituent(createClientApiClient(), constituentId);
      toast.success(t("success.deleted"));
      // Replace (not push) so the back button doesn't return to the now-gone
      // profile page.
      router.replace("/constituents");
      router.refresh();
    } catch (err) {
      if (!(err instanceof ApiProblem)) console.error("constituent.delete failed", err);
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
              {t("deleteDialog.description", { name: constituentName })}
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
