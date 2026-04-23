"use client";

import { CheckCircle2, LogIn, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { type FormEvent, Suspense, useCallback, useId, useState } from "react";
import { AuthCard } from "@/components/auth/auth-card";
import { AuthLogo } from "@/components/auth/auth-logo";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { verifySignup } from "@/services/SignupService";

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
  };

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "done">("idle");
  const [error, setError] = useState<string | undefined>();

  const handleSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      if (!token) {
        setError(t("errors.invalid"));
        return;
      }
      if (firstName.trim().length < 1 || lastName.trim().length < 1) {
        setError(t("errors.namesRequired"));
        return;
      }
      setStatus("submitting");
      setError(undefined);
      const res = await verifySignup(token, firstName.trim(), lastName.trim());
      if (res.ok) {
        setStatus("done");
        // Redirect to Keycloak login — once Keycloak 26 Organizations are in
        // (#114), the realm will emit a JWT with the correct `org_id` claim
        // for the freshly-minted user row.
        window.location.href = `/api/auth/login?hint=${encodeURIComponent(res.data.slug)}`;
        return;
      }
      setStatus("idle");
      if (res.status === 410) {
        setError(t("errors.expired"));
      } else if (res.status === 429) {
        setError(t("errors.rateLimited"));
      } else {
        setError(t("errors.generic"));
      }
    },
    [token, firstName, lastName, t],
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
          className="mb-4 flex items-start gap-3 rounded-lg border border-error-border bg-error-container p-3 text-sm text-on-error-container"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="flex-1">{error}</span>
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
