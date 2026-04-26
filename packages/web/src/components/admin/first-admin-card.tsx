"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { readAndClearStashedFirstAdminToken } from "@/components/admin/new-tenant-form";
import { formatAdminDate } from "@/components/admin/tenant-admin-shared";
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
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { ApiProblem } from "@/lib/api";
import {
  type AdminFirstAdminInvitation,
  buildInviteAcceptUrl,
  cancelFirstAdminInvitation,
  type InviteFirstAdminResult,
  inviteFirstAdmin,
  resendFirstAdminInvitation,
} from "@/services/TenantAdminService";

interface FirstAdminCardProps {
  tenantId: string;
  invitation: AdminFirstAdminInvitation | null;
  /**
   * Token returned by the create-with-first-admin form. Test-only injection
   * point — production runs read the token from `sessionStorage` via the
   * sibling reader so it never has to live in the URL bar / browser
   * history (PR #154 review HIGH).
   */
  initialFreshToken?: string;
  /** When true, the new-tenant form's invite call failed; surface inline. */
  initialError?: string;
}

interface InviteFormValues {
  email: string;
}

/**
 * Truncate a long URL in the middle, preserving the start (host + path
 * prefix) AND the end (the discriminating token tail) so a sighted operator
 * can verify the link before clicking Copy. Default `truncate` ellipses the
 * end, hiding exactly the bit that matters (PR #154 UX review L1).
 */
function middleTruncate(value: string, head = 32, tail = 12): string {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/**
 * Card on the super-admin tenant detail page that lets the operator seed
 * (and recover from) the first `org_admin` for an enterprise tenant.
 *
 * State machine driven by `invitation.status` from the detail response:
 *   - none      → empty state, render the invite form
 *   - pending   → email + sent-at + Resend / Cancel + copy-link affordance
 *   - accepted  → collapsed confirmation (the user lives in the Users tab)
 *   - expired   → same actions as pending; "Resend" rotates the token
 *
 * Copy-link policy: the raw token is only available immediately after a
 * fresh invite or a fresh resend (both paths return it in the response),
 * or via a one-shot `sessionStorage` handoff from the new-tenant form.
 * On a plain page reload we render a hint telling the operator to resend
 * to mint a fresh link — we deliberately do NOT expose the existing token
 * via the detail GET endpoint or via the URL bar.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: state-machine card with empty / pending / expired / accepted branches; splitting into sub-components would scatter the i18n + handler context. Tracked in PR #154 for refactor if it grows further.
export function FirstAdminCard({
  tenantId,
  invitation,
  initialFreshToken,
  initialError,
}: FirstAdminCardProps) {
  const t = useTranslations("admin.tenants.detail.firstAdmin");
  const router = useRouter();
  const [pending, setPending] = useState<"send" | "resend" | "cancel" | null>(null);
  const [freshToken, setFreshToken] = useState<string | null>(initialFreshToken ?? null);
  const [errorMessage, setErrorMessage] = useState<string | null>(initialError ?? null);
  const [copied, setCopied] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [busyAnnouncement, setBusyAnnouncement] = useState<string>("");

  const form = useForm<InviteFormValues>({
    mode: "onBlur",
    defaultValues: { email: "" },
  });

  // One-shot handoff from the new-tenant form. Reading + clearing here keeps
  // the token out of any persistent client-side surface — sessionStorage
  // ends with the tab.
  useEffect(() => {
    if (initialFreshToken) return;
    const stashed = readAndClearStashedFirstAdminToken(tenantId);
    if (stashed) setFreshToken(stashed);
  }, [tenantId, initialFreshToken]);

  if (invitation?.status === "accepted") {
    return (
      <section className="rounded-lg border border-outline-variant bg-surface-container-lowest p-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-text-secondary">{t("title")}</h2>
          <p className="text-sm text-text">
            {t("accepted.description", {
              email: invitation.email,
              date: formatAdminDate(invitation.acceptedAt),
            })}
          </p>
        </div>
      </section>
    );
  }

  async function onInvite(values: InviteFormValues) {
    setErrorMessage(null);
    setPending("send");
    setBusyAnnouncement(t("actions.sending"));
    try {
      const result = await inviteFirstAdmin(tenantId, values.email);
      handleFreshToken(result, t("success.invited", { email: values.email }));
      form.reset({ email: "" });
      router.refresh();
    } catch (error) {
      handleApiFailure(error);
    } finally {
      setPending(null);
      setBusyAnnouncement("");
    }
  }

  async function onResend() {
    if (!invitation) return;
    setErrorMessage(null);
    setPending("resend");
    setBusyAnnouncement(t("actions.resending"));
    try {
      const result = await resendFirstAdminInvitation(tenantId, invitation.id);
      handleFreshToken(result, t("success.resent"));
      router.refresh();
    } catch (error) {
      handleApiFailure(error);
    } finally {
      setPending(null);
      setBusyAnnouncement("");
    }
  }

  async function onCancelConfirmed() {
    if (!invitation) return;
    setErrorMessage(null);
    setPending("cancel");
    setBusyAnnouncement(t("actions.cancelling"));
    try {
      await cancelFirstAdminInvitation(tenantId, invitation.id);
      setFreshToken(null);
      setConfirmingCancel(false);
      toast.success(t("success.cancelled"));
      router.refresh();
    } catch (error) {
      handleApiFailure(error);
    } finally {
      setPending(null);
      setBusyAnnouncement("");
    }
  }

  function handleFreshToken(result: InviteFirstAdminResult, message: string) {
    setFreshToken(result.invitationToken);
    toast.success(message);
  }

  function handleApiFailure(error: unknown) {
    if (error instanceof ApiProblem) {
      if (error.status === 409) {
        setErrorMessage(t("errors.conflict"));
        toast.error(t("errors.conflict"));
        return;
      }
      if (error.status === 422) {
        setErrorMessage(t("errors.invalidEmail"));
        toast.error(t("errors.invalidEmail"));
        return;
      }
    }
    setErrorMessage(t("errors.generic"));
    toast.error(t("errors.generic"));
  }

  async function onCopyLink() {
    if (!freshToken) return;
    const url = buildInviteAcceptUrl(freshToken);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success(t("success.copied"));
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t("errors.copyFailed"));
    }
  }

  // ─── Empty state ────────────────────────────────────────────────────────
  if (!invitation) {
    return (
      <section
        className="rounded-lg border border-outline-variant bg-surface-container-lowest p-4"
        aria-busy={pending !== null}
      >
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-text-secondary">{t("title")}</h2>
          <p className="text-sm text-text-muted">{t("empty.description")}</p>
        </div>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onInvite)} className="mt-4 space-y-3" noValidate>
            <FormField
              control={form.control}
              name="email"
              rules={{
                required: t("fields.emailRequired"),
                pattern: {
                  value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
                  message: t("fields.emailInvalid"),
                },
                maxLength: { value: 255, message: t("fields.emailTooLong") },
              }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>{t("fields.email")}</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      type="email"
                      autoComplete="off"
                      placeholder={t("fields.emailPlaceholder")}
                      maxLength={255}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {errorMessage ? (
              <p className="text-sm text-error" role="alert">
                {errorMessage}
              </p>
            ) : null}
            <div className="flex justify-end">
              <Button type="submit" disabled={pending === "send"}>
                {pending === "send" ? t("actions.sending") : t("actions.send")}
              </Button>
            </div>
          </form>
        </Form>
        {/* Visually-hidden live region so AT users hear async-state changes
            (PR #154 UX review M3). */}
        <span className="sr-only" aria-live="polite">
          {busyAnnouncement}
        </span>
      </section>
    );
  }

  // ─── Pending / expired state ────────────────────────────────────────────
  const isExpired = invitation.status === "expired";
  const truncatedUrl = freshToken ? middleTruncate(buildInviteAcceptUrl(freshToken)) : "";
  const fullUrl = freshToken ? buildInviteAcceptUrl(freshToken) : "";

  return (
    <section
      className="rounded-lg border border-outline-variant bg-surface-container-lowest p-4"
      aria-busy={pending !== null}
    >
      <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-text-secondary">{t("title")}</h2>
          <p className="text-sm text-text">
            {isExpired
              ? t("expired.description", {
                  email: invitation.email,
                  date: formatAdminDate(invitation.expiresAt),
                })
              : t("pending.description", {
                  email: invitation.email,
                  date: formatAdminDate(invitation.createdAt),
                })}
          </p>
          {!isExpired ? (
            <p className="text-xs text-text-muted">
              {t("pending.expiresAt", { date: formatAdminDate(invitation.expiresAt) })}
            </p>
          ) : null}
        </div>
        <span
          className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ${
            isExpired
              ? "bg-error-container text-on-error-container"
              : "bg-primary-container text-on-primary-container"
          }`}
        >
          {isExpired ? t("badges.expired") : t("badges.pending")}
        </span>
      </div>

      {freshToken ? (
        <div className="mt-4 space-y-2 rounded-md border border-outline-variant bg-surface px-3 py-3">
          <p className="text-xs font-medium text-text-secondary">{t("copyLink.label")}</p>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <code
              title={fullUrl}
              className="flex-1 rounded bg-surface-container-lowest px-2 py-1 text-xs text-text"
            >
              {truncatedUrl}
            </code>
            <Button type="button" variant="secondary" onClick={() => void onCopyLink()}>
              {copied ? t("copyLink.copied") : t("copyLink.copy")}
            </Button>
          </div>
          <p className="text-xs text-text-muted">{t("copyLink.hint")}</p>
        </div>
      ) : (
        <p className="mt-4 text-xs text-text-muted">{t("pending.resendHint")}</p>
      )}

      {errorMessage ? (
        <p className="mt-3 text-sm text-error" role="alert">
          {errorMessage}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap gap-3">
        <Button
          type="button"
          variant="secondary"
          onClick={() => void onResend()}
          disabled={pending !== null}
        >
          {pending === "resend" ? t("actions.resending") : t("actions.resend")}
        </Button>
        <Button
          type="button"
          variant="destructive"
          onClick={() => setConfirmingCancel(true)}
          disabled={pending !== null}
        >
          {pending === "cancel" ? t("actions.cancelling") : t("actions.cancel")}
        </Button>
      </div>

      <AlertDialog
        open={confirmingCancel}
        onOpenChange={(open) => {
          if (!open && pending !== "cancel") setConfirmingCancel(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("cancelDialog.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("cancelDialog.description", { email: invitation.email })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel asChild>
              <Button variant="ghost" disabled={pending === "cancel"}>
                {t("cancelDialog.keep")}
              </Button>
            </AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={pending === "cancel"}
              onClick={() => void onCancelConfirmed()}
            >
              {pending === "cancel" ? t("actions.cancelling") : t("cancelDialog.confirm")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <span className="sr-only" aria-live="polite">
        {busyAnnouncement}
      </span>
    </section>
  );
}
