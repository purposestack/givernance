"use client";

import { LOCALE_NATIVE_NAMES, type Locale, SUPPORTED_LOCALES } from "@givernance/shared/i18n";
import { UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type FormEvent, useCallback, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { ApiProblem } from "@/lib/api";
import { createClientApiClient } from "@/lib/api/client-browser";
import type { InvitationRole } from "@/models/invitation";
import { InvitationService } from "@/services/InvitationService";

const ROLE_VALUES: readonly InvitationRole[] = ["user", "org_admin", "viewer"];

/**
 * Sentinel value used by the locale Select to mean "no admin override —
 * use the tenant default". Maps to `locale: null` at the API boundary,
 * which leaves `invitations.locale` NULL and lets the chain fall back
 * through to `tenants.default_locale`. (Issue #153 follow-up.)
 */
const FOLLOW_TENANT = "__follow_tenant__" as const;
type LocaleChoice = Locale | typeof FOLLOW_TENANT;

interface InviteActionProps {
  /**
   * Tenant's `default_locale`, used to label the picker's "Use workspace
   * default ({locale endonym})" option so the admin can see the value
   * they'd inherit by default. Issue #153 follow-up.
   */
  tenantDefaultLocale: Locale;
}

/**
 * "Invite teammate" page-header action. Holds its own dialog state so the
 * invitation flow is reachable both from the populated members table AND
 * from the empty-state card — the funds page convention is to put the
 * primary CTA in the header so the body content can render clean.
 */
export function InviteAction({ tenantDefaultLocale }: InviteActionProps) {
  const router = useRouter();
  const t = useTranslations("settings.members");
  const emailId = useId();
  const roleId = useId();
  const localeId = useId();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InvitationRole>("user");
  // Default to "follow tenant" so the existing one-click invite behaviour
  // is preserved — admins who don't care about per-invitee language don't
  // see new friction. Picking explicitly is the additive case (issue #153
  // follow-up: multi-language onboarding).
  const [localeChoice, setLocaleChoice] = useState<LocaleChoice>(FOLLOW_TENANT);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setEmail("");
    setRole("user");
    setLocaleChoice(FOLLOW_TENANT);
    setError(null);
  }, []);

  const handleClose = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) reset();
    },
    [reset],
  );

  const onSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const trimmed = email.trim();
      if (trimmed.length === 0) {
        setError(t("invite.errors.emailRequired"));
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        await InvitationService.createInvitation(createClientApiClient(), {
          email: trimmed,
          role,
          // FOLLOW_TENANT → null on the wire; the API persists NULL on
          // `invitations.locale` and the resolver falls through to
          // `tenants.default_locale`.
          locale: localeChoice === FOLLOW_TENANT ? null : localeChoice,
        });
        toast.success(t("success.invited", { email: trimmed }));
        handleClose(false);
        router.refresh();
      } catch (err) {
        if (!(err instanceof ApiProblem)) console.error("members.invite failed", err);
        if (err instanceof ApiProblem && err.detail) {
          setError(err.detail);
        } else {
          setError(t("invite.errors.generic"));
        }
      } finally {
        setSubmitting(false);
      }
    },
    [email, handleClose, localeChoice, role, router, t],
  );

  return (
    <>
      <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
        <UserPlus size={16} aria-hidden="true" />
        {t("actions.invite")}
      </Button>

      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("invite.title")}</DialogTitle>
            <DialogDescription>{t("invite.description")}</DialogDescription>
          </DialogHeader>
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            {error ? (
              <div
                role="alert"
                aria-live="polite"
                className="rounded-lg border border-error-border bg-error-container p-3 text-sm text-on-error-container"
              >
                {error}
              </div>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor={emailId} required>
                {t("invite.fields.email")}
              </Label>
              <Input
                id={emailId}
                type="email"
                autoComplete="email"
                required
                maxLength={255}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t("invite.fields.emailPlaceholder")}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor={roleId} required>
                {t("invite.fields.role")}
              </Label>
              <Select value={role} onValueChange={(v) => setRole(v as InvitationRole)}>
                <SelectTrigger id={roleId}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_VALUES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {t(`roles.${r}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-text-muted">{t(`invite.roleHints.${role}`)}</p>
            </div>

            {/*
             * Issue #153 follow-up — per-invitation locale. Lets the
             * admin pick the language for the welcome email + the
             * accept-form picker default, anticipating multi-language
             * onboarding (e.g. importing a CSV with mixed FR/EN
             * board members).
             */}
            <div className="space-y-2">
              <Label htmlFor={localeId}>{t("invite.fields.locale")}</Label>
              <Select
                value={localeChoice}
                onValueChange={(v) => setLocaleChoice(v as LocaleChoice)}
              >
                <SelectTrigger id={localeId}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {/* Endonyms — see LOCALE_NATIVE_NAMES docblock. */}
                  <SelectItem value={FOLLOW_TENANT}>
                    {t("invite.fields.localeFollowTenant", {
                      locale: LOCALE_NATIVE_NAMES[tenantDefaultLocale],
                    })}
                  </SelectItem>
                  {SUPPORTED_LOCALES.map((locale) => (
                    <SelectItem key={locale} value={locale}>
                      {LOCALE_NATIVE_NAMES[locale]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-text-muted">{t("invite.fields.localeHint")}</p>
            </div>

            <DialogFooter>
              <Button variant="ghost" onClick={() => handleClose(false)} disabled={submitting}>
                {t("invite.actions.cancel")}
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? t("invite.actions.submitting") : t("invite.actions.submit")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
