"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";

import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/shared/form-field";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { ApiProblem } from "@/lib/api";
import { createClientApiClient } from "@/lib/api/client-browser";
import type { PlatformAdmin } from "@/models/platform-admin";
import { PlatformAdminService } from "@/services/PlatformAdminService";

interface Props {
  admin: PlatformAdmin;
  /** Operator's own keycloak_id from the JWT — drives the self-removal hide rule. */
  operatorKeycloakId: string | null;
}

/**
 * Detail-page actions for a platform admin (issue #254): edit name,
 * re-trigger the password-reset email, soft-delete the admin.
 *
 * The remove button is hidden when the admin is the operator (self-removal
 * forbidden, matches the API guard). The dialogs map RFC 9457 status codes
 * onto i18n strings — `400 + LAST_ADMIN_FORBIDDEN` and
 * `400 + SELF_REMOVAL_FORBIDDEN` get distinct messages.
 */
export function PlatformAdminDetailActions({ admin, operatorKeycloakId }: Props) {
  const t = useTranslations("admin.platformAdmins.detail");
  const tFields = useTranslations("admin.platformAdmins.new.fields");
  const router = useRouter();

  // Hide-the-button check is intentionally a strict triple-null-guard:
  // when `operatorKeycloakId` is null (stale page load, refresh dropped
  // the JWT claim, parallel-tab race where the operator was logged out),
  // we DON'T treat the row as `isSelf` and the remove button stays
  // visible. The API guard (`SELF_REMOVAL_FORBIDDEN`) catches the actual
  // submit and the toast in `onRemoveConfirm` surfaces it. The UX cost
  // of an extra round-trip beats silently hiding the affordance under a
  // stale or partial auth state. (Frontend review m3.)
  const isSelf =
    admin.keycloakId !== null &&
    operatorKeycloakId !== null &&
    admin.keycloakId === operatorKeycloakId;
  const isRemoved = admin.deletedAt !== null;

  const [editOpen, setEditOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [pendingReset, setPendingReset] = useState(false);
  const [pendingRemove, setPendingRemove] = useState(false);

  const editForm = useForm<{ firstName: string; lastName: string }>({
    defaultValues: { firstName: admin.firstName, lastName: admin.lastName },
  });

  async function onEditSubmit(values: { firstName: string; lastName: string }) {
    const client = createClientApiClient();
    try {
      await PlatformAdminService.updateName(client, admin.id, {
        firstName: values.firstName.trim(),
        lastName: values.lastName.trim(),
      });
      toast.success(t("toast.renamed"));
      setEditOpen(false);
      router.refresh();
    } catch {
      // The rename endpoint has no specific error path beyond the
      // 404-not-found and the generic 502/500. Surface a generic toast;
      // the user can retry or hard-refresh the page.
      toast.error(t("errors.generic"));
    }
  }

  async function onResetConfirm() {
    setPendingReset(true);
    const client = createClientApiClient();
    try {
      await PlatformAdminService.resetPassword(client, admin.id);
      toast.success(t("toast.passwordResetSent"));
      setResetOpen(false);
    } catch {
      toast.error(t("errors.generic"));
    } finally {
      setPendingReset(false);
    }
  }

  async function onRemoveConfirm() {
    setPendingRemove(true);
    const client = createClientApiClient();
    try {
      await PlatformAdminService.remove(client, admin.id);
      toast.success(t("toast.removed"));
      setRemoveOpen(false);
      router.push("/admin/platform-admins");
      router.refresh();
    } catch (err) {
      if (err instanceof ApiProblem && err.status === 400) {
        const detail = err.detail ?? "";
        if (/own platform-admin row/i.test(detail)) {
          toast.error(t("errors.selfRemoval"));
        } else if (/last active/i.test(detail)) {
          toast.error(t("errors.lastAdmin"));
        } else {
          toast.error(t("errors.generic"));
        }
      } else if (err instanceof ApiProblem && err.status === 404) {
        toast.error(t("errors.notFound"));
      } else {
        toast.error(t("errors.generic"));
      }
    } finally {
      setPendingRemove(false);
    }
  }

  if (isRemoved) {
    return null;
  }

  return (
    <>
      <div className="flex flex-wrap gap-3">
        <Button variant="secondary" onClick={() => setEditOpen(true)}>
          {t("actions.editName")}
        </Button>
        <Button variant="secondary" onClick={() => setResetOpen(true)}>
          {t("actions.resetPassword")}
        </Button>
        {!isSelf ? (
          <Button variant="destructive" onClick={() => setRemoveOpen(true)}>
            {t("actions.remove")}
          </Button>
        ) : null}
      </div>

      {/* Edit-name dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("editDialog.title")}</DialogTitle>
            <DialogDescription>{t("editDialog.description")}</DialogDescription>
          </DialogHeader>
          <Form {...editForm}>
            <form
              id="platform-admin-rename"
              onSubmit={editForm.handleSubmit(onEditSubmit)}
              className="space-y-4"
            >
              {/* Email is shown read-only as context — outside the
                  FormField provider since it's not a controlled field. */}
              <div className="block text-sm">
                <label
                  htmlFor="platform-admin-edit-email"
                  className="mb-1 block text-on-surface-variant"
                >
                  {t("fields.email")}
                </label>
                <Input id="platform-admin-edit-email" value={admin.email} disabled />
              </div>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <FormField
                  control={editForm.control}
                  name="firstName"
                  rules={{ required: true, minLength: 1, maxLength: 255 }}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{tFields("firstName")}</FormLabel>
                      <FormControl>
                        {/* biome-ignore lint/a11y/noAutofocus: dialog focus convention */}
                        <Input {...field} autoFocus autoComplete="given-name" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={editForm.control}
                  name="lastName"
                  rules={{ required: true, minLength: 1, maxLength: 255 }}
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>{tFields("lastName")}</FormLabel>
                      <FormControl>
                        <Input {...field} autoComplete="family-name" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </form>
          </Form>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditOpen(false)}>
              {t("editDialog.cancel")}
            </Button>
            <Button
              type="submit"
              form="platform-admin-rename"
              disabled={editForm.formState.isSubmitting}
            >
              {editForm.formState.isSubmitting ? t("actions.saving") : t("editDialog.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset-password dialog */}
      <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("resetDialog.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("resetDialog.description", { email: admin.email })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pendingReset}>{t("resetDialog.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={onResetConfirm} disabled={pendingReset}>
              {pendingReset ? t("actions.sending") : t("resetDialog.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Remove-admin dialog */}
      <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("removeDialog.title")}</AlertDialogTitle>
            <AlertDialogDescription>{t("removeDialog.description")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pendingRemove}>
              {t("removeDialog.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={onRemoveConfirm}
              disabled={pendingRemove}
              className={buttonVariants({ variant: "destructive" })}
            >
              {pendingRemove ? t("actions.removing") : t("removeDialog.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
