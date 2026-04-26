"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { formatAdminDate } from "@/components/admin/tenant-admin-shared";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/shared/form-field";
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
   * Token returned by the create-with-first-admin form when the operator
   * lands on the detail page after submitting the new-tenant form. Lets the
   * copy-link affordance work on first render without a redundant resend.
   */
  initialFreshToken?: string;
  /** When true, the new-tenant form's invite call failed; surface inline. */
  initialError?: string;
}

interface InviteFormValues {
  email: string;
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
 * fresh invite or a fresh resend (both paths return it in the response).
 * On a plain page reload we render a hint telling the operator to resend
 * to get a new link — we deliberately do not expose the existing token in
 * a GET endpoint.
 */
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

  const form = useForm<InviteFormValues>({
    mode: "onBlur",
    defaultValues: { email: "" },
  });

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
    try {
      const result = await inviteFirstAdmin(tenantId, values.email);
      handleFreshToken(result, t("success.invited", { email: values.email }));
      form.reset({ email: "" });
      router.refresh();
    } catch (error) {
      handleApiFailure(error);
    } finally {
      setPending(null);
    }
  }

  async function onResend() {
    if (!invitation) return;
    setErrorMessage(null);
    setPending("resend");
    try {
      const result = await resendFirstAdminInvitation(tenantId, invitation.id);
      handleFreshToken(result, t("success.resent"));
      router.refresh();
    } catch (error) {
      handleApiFailure(error);
    } finally {
      setPending(null);
    }
  }

  async function onCancel() {
    if (!invitation) return;
    setErrorMessage(null);
    setPending("cancel");
    try {
      await cancelFirstAdminInvitation(tenantId, invitation.id);
      setFreshToken(null);
      toast.success(t("success.cancelled"));
      router.refresh();
    } catch (error) {
      handleApiFailure(error);
    } finally {
      setPending(null);
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
      <section className="rounded-lg border border-outline-variant bg-surface-container-lowest p-4">
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
      </section>
    );
  }

  // ─── Pending / expired state ────────────────────────────────────────────
  const isExpired = invitation.status === "expired";

  return (
    <section className="rounded-lg border border-outline-variant bg-surface-container-lowest p-4">
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
            <code className="flex-1 truncate rounded bg-surface-container-lowest px-2 py-1 text-xs text-text">
              {buildInviteAcceptUrl(freshToken)}
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
          onClick={() => void onCancel()}
          disabled={pending !== null}
        >
          {pending === "cancel" ? t("actions.cancelling") : t("actions.cancel")}
        </Button>
      </div>
    </section>
  );
}
