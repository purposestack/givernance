"use client";

import { Mail, RefreshCcw, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense, useCallback, useState } from "react";
import { AuthCard } from "@/components/auth/auth-card";
import { AuthLogo } from "@/components/auth/auth-logo";
import { resendVerification } from "@/services/SignupService";

/**
 * "Check your email" screen (issue #109 / doc 22 §6.1).
 *
 * The email address from the signup POST is passed via query string; the
 * page reads it only to render. The resend call does not disclose the
 * inbox's existence (the API returns 204 regardless of match).
 */
function SuccessContent() {
  const t = useTranslations("auth.signupSuccess");
  const params = useSearchParams();
  const email = params.get("email") ?? "";
  const [resending, setResending] = useState(false);
  const [resendState, setResendState] = useState<"idle" | "sent" | "too_many">("idle");

  const handleResend = useCallback(async () => {
    if (!email || resending) return;
    setResending(true);
    try {
      await resendVerification(email);
      setResendState("sent");
    } finally {
      setResending(false);
    }
  }, [email, resending]);

  return (
    <AuthCard>
      <AuthLogo />

      <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-full bg-primary-50 text-primary">
        <Mail className="h-6 w-6" aria-hidden="true" />
      </div>

      <h1 className="mb-2 text-center font-heading text-xl text-text">{t("title")}</h1>
      <p className="mb-6 text-center text-sm text-text-secondary">
        {email
          ? t.rich("subtitle", { email: () => <strong>{email}</strong> })
          : t("subtitleNoEmail")}
      </p>

      {resendState === "sent" && (
        <div
          role="status"
          className="mb-4 rounded-lg border border-primary-100 bg-primary-50 p-3 text-sm text-on-surface"
        >
          {t("resendSent")}
        </div>
      )}

      {resendState === "too_many" && (
        <div
          role="alert"
          className="mb-4 flex items-start gap-3 rounded-lg border border-[rgba(186,26,26,0.12)] bg-error-container p-3 text-sm text-on-error-container"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{t("resendTooMany")}</span>
        </div>
      )}

      <button
        type="button"
        onClick={handleResend}
        disabled={resending || !email}
        className="inline-flex h-[var(--btn-height-md)] w-full items-center justify-center gap-2 rounded-button border border-outline-variant bg-surface-container-lowest px-6 text-sm font-medium text-on-surface transition-opacity duration-normal ease-out hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60"
      >
        <RefreshCcw className="h-4 w-4" aria-hidden="true" />
        {resending ? t("resending") : t("resend")}
      </button>

      <p className="mt-6 text-center text-xs text-text-muted">{t("spamHint")}</p>

      <div className="mt-6 border-t border-neutral-100 pt-6 text-center">
        <p className="text-sm text-text-secondary">
          <Link href="/login" className="font-medium text-primary hover:underline">
            {t("backToLogin")}
          </Link>
        </p>
      </div>
    </AuthCard>
  );
}

export default function SignupSuccessPage() {
  return (
    <Suspense
      fallback={
        <AuthCard>
          <span role="status">Loading…</span>
        </AuthCard>
      }
    >
      <SuccessContent />
    </Suspense>
  );
}
