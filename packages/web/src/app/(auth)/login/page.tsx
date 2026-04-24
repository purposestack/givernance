"use client";

import { LogIn, Shield, TriangleAlert, X } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense, useCallback, useState } from "react";
import { AuthCard } from "@/components/auth/auth-card";
import { AuthLogo } from "@/components/auth/auth-logo";

function LoginForm() {
  const t = useTranslations("auth.login");
  const searchParams = useSearchParams();
  const errorParam = searchParams.get("error");
  const [alertVisible, setAlertVisible] = useState(!!errorParam);
  const [redirecting, setRedirecting] = useState(false);

  /** Map error query params to user-friendly messages. */
  function getErrorMessage(error: string): string {
    switch (error) {
      case "token_exchange_failed":
        return t("errors.authFailed");
      case "callback_failed":
        return t("errors.generic");
      case "invalid_state":
        return t("errors.sessionExpired");
      case "missing_verifier":
        return t("errors.interrupted");
      case "missing_org_id":
        return t("errors.authFailed");
      default:
        return t("errors.generic");
    }
  }

  const handleLogin = useCallback(() => {
    setRedirecting(true);
    window.location.href = "/api/auth/login";
  }, []);

  return (
    <AuthCard>
      <AuthLogo />

      {/* Organization badge — .auth-org from mockup (subdomain-detected org) */}
      <div className="mx-auto mb-6 flex w-fit items-center justify-center gap-2 rounded-pill bg-neutral-100 px-4 py-1.5">
        <span className="h-2 w-2 shrink-0 rounded-full bg-primary" />
        <span className="max-w-[280px] truncate text-xs font-medium text-text-secondary">
          {t("orgBadge")}
        </span>
      </div>

      {/* Title & subtitle */}
      <h1 className="mb-2 text-center font-heading text-xl text-text">{t("title")}</h1>
      <p className="mb-8 text-center text-sm text-text-secondary">{t("subtitle")}</p>

      {/* Error alert — shown when redirected back from Keycloak with an error */}
      {alertVisible && errorParam && (
        <div
          className="mb-5 flex items-start gap-3 rounded-lg border border-[rgba(186,26,26,0.12)] bg-error-container p-3 text-sm text-on-error-container"
          role="alert"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="flex-1">{getErrorMessage(errorParam)}</span>
          <button
            type="button"
            aria-label={t("close")}
            onClick={() => setAlertVisible(false)}
            className="shrink-0 border-none bg-transparent p-0 leading-none text-inherit opacity-70 transition-opacity duration-normal ease-out hover:opacity-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Primary sign-in button — redirects to Keycloak OIDC */}
      <button
        type="button"
        onClick={handleLogin}
        disabled={redirecting}
        className="inline-flex h-[var(--btn-height-lg)] w-full items-center justify-center gap-2 rounded-button border-none bg-primary px-8 font-body text-base font-medium text-on-primary transition-opacity duration-normal ease-out hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60"
      >
        {redirecting ? (
          <>
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-on-primary border-t-transparent" />
            {t("redirecting")}
          </>
        ) : (
          <>
            <LogIn className="h-4 w-4" aria-hidden="true" />
            {t("submit")}
          </>
        )}
      </button>

      {/* Security hint */}
      <div className="mt-4 flex items-center justify-center gap-1.5 text-xs text-text-muted">
        <Shield className="h-3 w-3" aria-hidden="true" />
        <span>{t("securityHint")}</span>
      </div>

      {/* Request access */}
      <div className="mt-6 border-t border-neutral-100 pt-6 text-center">
        <p className="text-sm text-text-secondary">
          {t.rich("noAccount", {
            link: (chunks) => (
              <Link
                href="/signup"
                className="font-medium text-primary no-underline transition-colors duration-normal ease-out hover:text-primary-dark hover:underline"
              >
                {chunks}
              </Link>
            ),
          })}
        </p>
      </div>
    </AuthCard>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<span role="status">Loading...</span>}>
      <LoginForm />
    </Suspense>
  );
}
