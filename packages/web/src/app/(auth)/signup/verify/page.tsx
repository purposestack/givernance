"use client";

import { PASSWORD_MIN_LENGTH } from "@givernance/shared/constants";
import { CheckCircle2, LogIn, Mail, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { type FormEvent, Suspense, useCallback, useEffect, useId, useRef, useState } from "react";
import { AuthCard } from "@/components/auth/auth-card";
import { AuthLogo } from "@/components/auth/auth-logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { resendVerification, verifySignup } from "@/services/SignupService";

type ValidationKey = "invalid" | "namesRequired" | "passwordTooShort" | "passwordMismatch";

interface VerifyFormFields {
  token: string;
  firstName: string;
  lastName: string;
  password: string;
  passwordConfirm: string;
}

/** Pure validation — returns the i18n error key or null when the form is OK. */
function validateVerifyForm(f: VerifyFormFields): ValidationKey | null {
  if (!f.token) return "invalid";
  if (f.firstName.trim().length < 1 || f.lastName.trim().length < 1) return "namesRequired";
  if (f.password.length < PASSWORD_MIN_LENGTH) return "passwordTooShort";
  if (f.password !== f.passwordConfirm) return "passwordMismatch";
  return null;
}

/**
 * Inline resend-link form rendered when verify fails with a 410 (expired or
 * already-used token). The API treats every resend response as 204 regardless
 * of whether the email matches a pending or half-provisioned tenant — so the
 * UI can't distinguish "sent" from "no match" without leaking enumeration
 * signal. We always show the same "if your email matches, we've sent a new
 * link" confirmation.
 *
 * F13 surfaces a "Try a different email" reset so a typo'd address isn't a
 * dead-end. The live region stays mounted across both states so screen
 * readers reliably announce subsequent submits (re-mounting a fresh
 * `aria-live` element on each submit is unreliable across SRs).
 */
function ResendForm() {
  const t = useTranslations("auth.signupVerify");
  const inputId = useId();
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "submitting" | "sent">("idle");
  const emailInputRef = useRef<HTMLInputElement>(null);
  // Tracks whether the user has been through a successful submit at least
  // once, so the "back to idle" useEffect only re-focuses the input on a
  // user-initiated reset — not on the initial render of the form.
  const wasSentRef = useRef(false);

  const onSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (email.trim().length === 0) return;
      setState("submitting");
      await resendVerification(email.trim());
      setState("sent");
      wasSentRef.current = true;
    },
    [email],
  );

  const onReset = useCallback(() => {
    setEmail("");
    setState("idle");
  }, []);

  // F13 — restore focus to the email input after a reset so keyboard /
  // SR users don't tab from the page root all the way back through the
  // alert and label. Gated on `wasSentRef` so the initial mount doesn't
  // steal focus on page load.
  useEffect(() => {
    if (state === "idle" && wasSentRef.current) {
      emailInputRef.current?.focus();
    }
  }, [state]);

  return (
    <div className="mt-3 space-y-2">
      <form onSubmit={onSubmit} className="space-y-2" hidden={state === "sent"}>
        <Label htmlFor={inputId}>{t("resend.label")}</Label>
        <div className="flex gap-2">
          <Input
            id={inputId}
            ref={emailInputRef}
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t("resend.placeholder")}
          />
          <Button
            type="submit"
            variant="primary"
            size="default"
            disabled={state === "submitting"}
            className="shrink-0 px-4"
          >
            {state === "submitting" ? (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-on-primary border-t-transparent" />
            ) : (
              <Mail className="h-4 w-4" aria-hidden="true" />
            )}
            {t("resend.submit")}
          </Button>
        </div>
      </form>

      {/*
        Persistent live region — kept mounted in BOTH states so subsequent
        successful submits are reliably announced. `aria-live="polite"`
        will only re-announce when the *content* of the region changes,
        which is why unmounting the <p> on reset (and remounting on send)
        loses the second announcement.
      */}
      <p className="text-sm text-text-secondary" role="status" aria-live="polite">
        {state === "sent" ? t("resend.sent") : ""}
      </p>

      {state === "sent" && (
        <Button type="button" variant="link" size="inline" onClick={onReset}>
          {t("resend.tryDifferent")}
        </Button>
      )}
    </div>
  );
}

/**
 * Email verification landing (issue #109 / doc 22 §6.2).
 *
 * This runs in the browser because the verify endpoint is a POST with
 * firstName/lastName in the body — we collect those on this page (the
 * original signup form only captured the organization's admin name; the
 * email owner may actually be a different person if the signup admin used
 * a shared inbox). On success we redirect into the dashboard via the
 * existing Keycloak login round-trip.
 */
function VerifyContent() {
  const t = useTranslations("auth.signupVerify");
  const params = useSearchParams();
  const token = params.get("token") ?? "";

  const ids = {
    firstName: useId(),
    lastName: useId(),
    password: useId(),
    passwordConfirm: useId(),
  };

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "done">("idle");
  const [error, setError] = useState<string | undefined>();
  // Tracks the last server status so we can conditionally render the resend
  // form only when the failure mode (410) is actually recoverable that way.
  const [errorStatus, setErrorStatus] = useState<number | null>(null);

  const handleSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const validation = validateVerifyForm({
        token,
        firstName,
        lastName,
        password,
        passwordConfirm,
      });
      if (validation) {
        setError(t(`errors.${validation}`, { min: PASSWORD_MIN_LENGTH }));
        setErrorStatus(null);
        return;
      }
      setStatus("submitting");
      setError(undefined);
      setErrorStatus(null);
      const res = await verifySignup(token, firstName.trim(), lastName.trim(), password);
      if (res.ok) {
        setStatus("done");
        // Redirect to Keycloak login — the API just provisioned the realm
        // Organization, the user with the chosen password, and the
        // membership, plus stamped the `org_id` user attribute that the
        // realm's mapper turns into the JWT claim the callback requires.
        // `?hint=<slug>` is forwarded as `kc_idp_hint` so federated
        // tenants land directly on their IdP (issue #150); KC ignores
        // it for non-federated or unmatched aliases — useful breadcrumb
        // for operators debugging "why didn't the IdP open".
        window.location.href = `/api/auth/login?hint=${encodeURIComponent(res.data.slug)}`;
        return;
      }
      setStatus("idle");
      const errorKey =
        res.status === 410 ? "expired" : res.status === 429 ? "rateLimited" : "generic";
      setError(t(`errors.${errorKey}`));
      setErrorStatus(res.status);
    },
    [token, firstName, lastName, password, passwordConfirm, t],
  );

  if (!token) {
    return (
      <AuthCard>
        <AuthLogo />
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-error-container text-on-error-container">
          <TriangleAlert className="h-6 w-6" aria-hidden="true" />
        </div>
        <h1 className="mb-2 text-center font-heading text-xl text-text">{t("errorTitle")}</h1>
        <p className="mb-6 text-center text-sm text-text-secondary">{t("errors.missingToken")}</p>
        <Link
          href="/signup"
          className="inline-flex h-[var(--btn-height-md)] w-full items-center justify-center rounded-button bg-primary px-6 text-sm font-medium text-on-primary"
        >
          {t("restartSignup")}
        </Link>
      </AuthCard>
    );
  }

  if (status === "done") {
    return (
      <AuthCard>
        <AuthLogo />
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary-50 text-primary">
          <CheckCircle2 className="h-6 w-6" aria-hidden="true" />
        </div>
        <h1 className="mb-2 text-center font-heading text-xl text-text">{t("successTitle")}</h1>
        <p className="mb-6 text-center text-sm text-text-secondary">{t("successBody")}</p>
        <div className="flex items-center justify-center text-xs text-text-muted">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard>
      <AuthLogo />
      <h1 className="mb-2 text-center font-heading text-xl text-text">{t("title")}</h1>
      <p className="mb-6 text-center text-sm text-text-secondary">{t("subtitle")}</p>

      {error && (
        <div
          role="alert"
          aria-live="polite"
          className="mb-4 rounded-lg border border-error-border bg-error-container p-3 text-sm text-on-error-container"
        >
          <div className="flex items-start gap-3">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="flex-1">{error}</span>
          </div>
          {errorStatus === 410 && <ResendForm />}
        </div>
      )}

      <form noValidate onSubmit={handleSubmit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor={ids.firstName} required>
              {t("fields.firstName")}
            </Label>
            <Input
              id={ids.firstName}
              name="firstName"
              autoComplete="given-name"
              required
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              maxLength={255}
            />
          </div>
          <div>
            <Label htmlFor={ids.lastName} required>
              {t("fields.lastName")}
            </Label>
            <Input
              id={ids.lastName}
              name="lastName"
              autoComplete="family-name"
              required
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              maxLength={255}
            />
          </div>
        </div>

        <div>
          <Label htmlFor={ids.password} required>
            {t("fields.password")}
          </Label>
          <Input
            id={ids.password}
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            maxLength={128}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-describedby={`${ids.password}-hint`}
          />
          <p id={`${ids.password}-hint`} className="mt-1 text-xs text-text-muted">
            {t("fields.passwordHint", { min: PASSWORD_MIN_LENGTH })}
          </p>
        </div>

        <div>
          <Label htmlFor={ids.passwordConfirm} required>
            {t("fields.passwordConfirm")}
          </Label>
          <Input
            id={ids.passwordConfirm}
            name="passwordConfirm"
            type="password"
            autoComplete="new-password"
            required
            minLength={PASSWORD_MIN_LENGTH}
            maxLength={128}
            value={passwordConfirm}
            onChange={(e) => setPasswordConfirm(e.target.value)}
          />
        </div>

        <button
          type="submit"
          disabled={status === "submitting"}
          className="inline-flex h-[var(--btn-height-lg)] w-full items-center justify-center gap-2 rounded-button bg-primary px-8 font-body text-base font-medium text-on-primary transition-opacity duration-normal ease-out hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60"
        >
          {status === "submitting" ? (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-on-primary border-t-transparent" />
          ) : (
            <LogIn className="h-4 w-4" aria-hidden="true" />
          )}
          {t("submit")}
        </button>
      </form>
    </AuthCard>
  );
}

export default function VerifyPage() {
  return (
    <Suspense
      fallback={
        <AuthCard>
          <span role="status">Loading…</span>
        </AuthCard>
      }
    >
      <VerifyContent />
    </Suspense>
  );
}
