"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
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

function evaluateStrength(password: string): StrengthResult {
  let score = 0;
  if (password.length >= 8) score++;
  if (/[A-Z]/.test(password)) score++;
  if (/\d/.test(password)) score++;
  if (/[!@#$%&*]/.test(password)) score++;

  if (score <= 1) return { level: "weak", label: "Weak", segments: 1 };
  if (score === 2) return { level: "medium", label: "Medium", segments: 2 };
  if (score === 3) return { level: "strong", label: "Strong", segments: 3 };
  return { level: "very-strong", label: "Very strong", segments: 4 };
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
  const searchParams = useSearchParams();
  const token = searchParams.get("token");
  const expired = searchParams.get("expired");

  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  const strength = useMemo(() => evaluateStrength(password), [password]);

  const rules = useMemo(
    () => [
      { label: "At least 8 characters", valid: password.length >= 8 },
      { label: "At least one uppercase letter", valid: /[A-Z]/.test(password) },
      { label: "At least one number", valid: /\d/.test(password) },
      { label: "At least one special character (!@#$%&*)", valid: /[!@#$%&*]/.test(password) },
    ],
    [password],
  );

  // Token expired state — alternate view from mockup
  if (expired) {
    return (
      <AuthCard>
        <AuthLogo />
        <h1 className="mb-2 text-center font-heading text-xl text-text">Link expired</h1>
        <p className="mb-6 text-center text-sm text-text-secondary">
          This reset link is no longer valid or has expired.
        </p>

        <div
          className="mb-5 flex items-start gap-3 rounded-lg border border-[rgba(186,26,26,0.12)] bg-error-container p-3 text-sm text-on-error-container"
          role="alert"
        >
          <span className="shrink-0 text-md" aria-hidden="true">
            &#9888;
          </span>
          <span className="flex-1">
            The reset link expired after 1 hour. Please request a new one.
          </span>
        </div>

        <Link
          href="/forgot-password"
          className="inline-flex h-[var(--btn-height-lg)] w-full items-center justify-center rounded-button bg-primary px-8 text-base font-medium text-on-primary no-underline transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          Request a new link
        </Link>

        <div className="mt-5 text-center">
          <Link
            href="/login"
            className="text-sm font-medium text-primary no-underline transition-colors hover:text-primary-dark hover:underline"
          >
            &larr; Back to sign in
          </Link>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard>
      <AuthLogo />

      <h1 className="mb-2 text-center font-heading text-xl text-text">New password</h1>
      <p className="mb-6 text-center text-sm text-text-secondary">
        Choose a secure password for your account.
      </p>

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
            New password
          </label>
          <div className="relative">
            <input
              className="h-[var(--input-height)] w-full rounded-input border border-outline-variant bg-surface-container-lowest px-3 pr-10 font-body text-base text-text placeholder:text-text-muted focus:border-primary focus:shadow-ring focus:outline-none"
              type={showPassword ? "text" : "password"}
              id="password"
              name="password"
              placeholder="Your new password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button
              type="button"
              aria-label={showPassword ? "Hide password" : "Show password"}
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 border-none bg-transparent p-1 text-sm leading-none text-text-muted transition-colors hover:text-text-secondary"
            >
              {showPassword ? "Hide" : "Show"}
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
            Confirm password
          </label>
          <div className="relative">
            <input
              className="h-[var(--input-height)] w-full rounded-input border border-outline-variant bg-surface-container-lowest px-3 pr-10 font-body text-base text-text placeholder:text-text-muted focus:border-primary focus:shadow-ring focus:outline-none"
              type={showConfirm ? "text" : "password"}
              id="password-confirm"
              name="password_confirm"
              placeholder="Confirm your password"
              autoComplete="new-password"
              required
            />
            <button
              type="button"
              aria-label={showConfirm ? "Hide password" : "Show password"}
              onClick={() => setShowConfirm((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 border-none bg-transparent p-1 text-sm leading-none text-text-muted transition-colors hover:text-text-secondary"
            >
              {showConfirm ? "Hide" : "Show"}
            </button>
          </div>
        </div>

        {/* Password rules checklist */}
        <div className="rounded-md bg-neutral-100 p-3">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
            Security requirements
          </div>
          {rules.map((rule) => (
            <div
              key={rule.label}
              className={`flex items-center gap-2 py-px text-xs ${
                rule.valid ? "text-primary-dark" : "text-text-secondary"
              }`}
            >
              <span
                className={`w-4 shrink-0 text-center text-[10px] ${rule.valid ? "text-primary" : ""}`}
              >
                {rule.valid ? "\u2713" : "\u25CB"}
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
            Reset password
          </button>
        </div>
      </form>

      {/* Back to login */}
      <div className="mt-5 text-center">
        <Link
          href="/login"
          className="text-sm font-medium text-primary no-underline transition-colors hover:text-primary-dark hover:underline"
        >
          &larr; Back to sign in
        </Link>
      </div>
    </AuthCard>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetPasswordForm />
    </Suspense>
  );
}
