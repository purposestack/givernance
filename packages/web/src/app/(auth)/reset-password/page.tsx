"use client";

import { ArrowLeft, Check, Circle, Eye, EyeOff, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense, useMemo, useState } from "react";
import { AuthCard } from "@/components/auth/auth-card";
import { AuthLogo } from "@/components/auth/auth-logo";

/** Password strength levels matching the mockup's 4-segment meter. */
type StrengthLevel = "weak" | "medium" | "strong" | "very-strong";

interface StrengthResult {
  level: StrengthLevel;
  label: string;
  segments: number;
}

/** Segment color classes keyed by strength level (matching mockup token usage). */
const SEGMENT_COLORS: Record<StrengthLevel, string> = {
  weak: "bg-indigo",
  medium: "bg-amber",
  strong: "bg-primary-light",
  "very-strong": "bg-primary",
};

const LABEL_COLORS: Record<StrengthLevel, string> = {
  weak: "text-indigo",
  medium: "text-amber",
  strong: "text-primary-light",
  "very-strong": "text-primary",
};

function ResetPasswordForm() {
  const t = useTranslations("auth.resetPassword");
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const expired = searchParams.get("expired");

  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const strength = useMemo((): StrengthResult => {
    let score = 0;
    if (password.length >= 8) score++;
    if (/[A-Z]/.test(password)) score++;
    if (/\d/.test(password)) score++;
    if (/[!@#$%&*]/.test(password)) score++;

    if (score <= 1) return { level: "weak", label: t("strength.weak"), segments: 1 };
    if (score === 2) return { level: "medium", label: t("strength.medium"), segments: 2 };
    if (score === 3) return { level: "strong", label: t("strength.strong"), segments: 3 };
    return { level: "very-strong", label: t("strength.veryStrong"), segments: 4 };
  }, [password, t]);

  const rules = useMemo(
    () => [
      { label: t("requirements.minLength"), valid: password.length >= 8 },
      { label: t("requirements.uppercase"), valid: /[A-Z]/.test(password) },
      { label: t("requirements.number"), valid: /\d/.test(password) },
      { label: t("requirements.special"), valid: /[!@#$%&*]/.test(password) },
    ],
    [password, t],
  );

  // Token expired state — alternate view from mockup
  if (expired) {
    return (
      <AuthCard>
        <AuthLogo />
        <h1 className="mb-2 text-center font-heading text-xl text-text">{t("expiredTitle")}</h1>
        <p className="mb-6 text-center text-sm text-text-secondary">{t("expiredMessage")}</p>

        <div
          className="mb-5 flex items-start gap-3 rounded-lg border border-[rgba(186,26,26,0.12)] bg-error-container p-3 text-sm text-on-error-container"
          role="alert"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="flex-1">{t("expiredAlert")}</span>
        </div>

        <Link
          href="/forgot-password"
          className="inline-flex h-[var(--btn-height-lg)] w-full items-center justify-center rounded-button bg-primary px-8 text-base font-medium text-on-primary no-underline transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          {t("requestNewLink")}
        </Link>

        <div className="mt-5 text-center">
          <Link
            href="/login"
            className="text-sm font-medium text-primary no-underline transition-colors hover:text-primary-dark hover:underline"
          >
            <ArrowLeft className="inline h-3.5 w-3.5" /> {t("backToLogin")}
          </Link>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard>
      <AuthLogo />

      <h1 className="mb-2 text-center font-heading text-xl text-text">{t("title")}</h1>
      <p className="mb-6 text-center text-sm text-text-secondary">{t("subtitle")}</p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          // Phase 1: Keycloak handles password reset server-side.
          // This form posts the token + new password to the callback API.
          const formData = new FormData(e.currentTarget);
          const body = {
            token: token ?? formData.get("token"),
            password: formData.get("password"),
          };

          fetch("/api/auth/reset-password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }).then((res) => {
            if (res.ok) {
              window.location.href = "/login?reset=success";
            } else {
              window.location.href = "/reset-password?expired=true";
            }
          });
        }}
        noValidate
      >
        {token && <input type="hidden" name="token" value={token} />}

        {/* New password */}
        <div className="mb-5">
          <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-text">
            {t("passwordLabel")}
          </label>
          <div className="relative">
            <input
              className="h-[var(--input-height)] w-full rounded-input border border-outline-variant bg-surface-container-lowest px-3 pr-10 font-body text-base text-text placeholder:text-text-muted focus:border-primary focus:shadow-ring focus:outline-none"
              type={showPassword ? "text" : "password"}
              id="password"
              name="password"
              placeholder={t("passwordPlaceholder")}
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              type="button"
              aria-label={showPassword ? t("hidePassword") : t("showPassword")}
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 border-none bg-transparent p-1 leading-none text-text-muted transition-colors hover:text-text-secondary"
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>

          {/* Strength meter — 4-segment bar matching mockup */}
          {password.length > 0 && (
            <div className="mt-2">
              <div className="mb-1 flex gap-1">
                {[1, 2, 3, 4].map((i) => (
                  <div
                    key={i}
                    className={`h-1 flex-1 rounded-pill transition-colors duration-normal ease-out ${
                      i <= strength.segments ? SEGMENT_COLORS[strength.level] : "bg-neutral-200"
                    }`}
                  />
                ))}
              </div>
              <div
                className={`flex items-center gap-1 text-xs font-medium ${LABEL_COLORS[strength.level]}`}
              >
                <span className="text-[8px]">&#9679;</span> {strength.label}
              </div>
            </div>
          )}
        </div>

        {/* Confirm password */}
        <div className="mb-5">
          <label htmlFor="password-confirm" className="mb-1.5 block text-sm font-medium text-text">
            {t("confirmLabel")}
          </label>
          <div className="relative">
            <input
              className="h-[var(--input-height)] w-full rounded-input border border-outline-variant bg-surface-container-lowest px-3 pr-10 font-body text-base text-text placeholder:text-text-muted focus:border-primary focus:shadow-ring focus:outline-none"
              type={showConfirm ? "text" : "password"}
              id="password-confirm"
              name="password_confirm"
              placeholder={t("confirmPlaceholder")}
              autoComplete="new-password"
              required
            />
            <button
              type="button"
              aria-label={showConfirm ? t("hidePassword") : t("showPassword")}
              onClick={() => setShowConfirm((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 border-none bg-transparent p-1 leading-none text-text-muted transition-colors hover:text-text-secondary"
            >
              {showConfirm ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>

        {/* Password rules checklist */}
        <div className="rounded-md bg-neutral-100 px-4 py-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
            {t("securityTitle")}
          </div>
          {rules.map((rule) => (
            <div
              key={rule.label}
              className={`flex items-center gap-2 py-px text-xs ${
                rule.valid ? "text-primary-dark" : "text-text-secondary"
              }`}
            >
              <span className={`w-4 shrink-0 text-center ${rule.valid ? "text-primary" : ""}`}>
                {rule.valid ? <Check className="h-3 w-3" /> : <Circle className="h-2.5 w-2.5" />}
              </span>
              <span>{rule.label}</span>
            </div>
          ))}
        </div>

        {/* Submit */}
        <div className="mt-6">
          <button
            type="submit"
            className="inline-flex h-[var(--btn-height-lg)] w-full items-center justify-center rounded-button bg-primary px-8 text-base font-medium text-on-primary transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            {t("submit")}
          </button>
        </div>
      </form>

      {/* Back to login */}
      <div className="mt-5 text-center">
        <Link
          href="/login"
          className="text-sm font-medium text-primary no-underline transition-colors hover:text-primary-dark hover:underline"
        >
          &larr; {t("backToLogin")}
        </Link>
      </div>
    </AuthCard>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<span role="status">Loading...</span>}>
      <ResetPasswordForm />
    </Suspense>
  );
}
