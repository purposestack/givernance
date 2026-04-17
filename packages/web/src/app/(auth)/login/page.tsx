"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useState } from "react";
import { AuthCard } from "@/components/auth/auth-card";
import { AuthLogo } from "@/components/auth/auth-logo";

/** SVG icon for Google Workspace SSO button. */
function GoogleIcon() {
  return (
    <svg className="h-[18px] w-[18px] shrink-0" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18A10.96 10.96 0 0 0 1 12c0 1.77.42 3.44 1.18 4.93l3.66-2.84z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}

/** Map error query params to user-friendly messages. */
function getErrorMessage(error: string): string {
  switch (error) {
    case "token_exchange_failed":
      return "Authentication failed. Please try again.";
    case "callback_failed":
      return "Something went wrong during sign-in. Please try again.";
    default:
      return "Invalid credentials. Check your email and password.";
  }
}

function LoginForm() {
  const searchParams = useSearchParams();
  const errorParam = searchParams.get("error");
  const [showPassword, setShowPassword] = useState(false);
  const [alertVisible, setAlertVisible] = useState(!!errorParam);

  const handleSSOLogin = useCallback(() => {
    window.location.href = "/api/auth/login";
  }, []);

  return (
    <AuthCard>
      <AuthLogo />

      {/* Title & subtitle — auth-title / auth-subtitle from mockup */}
      <h1 className="mb-2 text-center font-heading text-xl text-text">Sign in</h1>
      <p className="mb-6 text-center text-sm text-text-secondary">
        Access your management workspace
      </p>

      {/* Error alert — alert alert-error from base.css */}
      {alertVisible && errorParam && (
        <div
          className="mb-5 flex items-start gap-3 rounded-lg border border-[rgba(186,26,26,0.12)] bg-error-container p-3 text-sm text-on-error-container"
          role="alert"
        >
          <span className="shrink-0 text-md" aria-hidden="true">
            &#9888;
          </span>
          <span className="flex-1">{getErrorMessage(errorParam)}</span>
          <button
            type="button"
            aria-label="Close"
            onClick={() => setAlertVisible(false)}
            className="shrink-0 border-none bg-transparent p-0 text-md leading-none text-inherit opacity-70 transition-opacity duration-normal ease-out hover:opacity-100"
          >
            &#10005;
          </button>
        </div>
      )}

      {/* Login form — submits to Keycloak via the API route */}
      <form action="/api/auth/login" method="get" noValidate>
        {/* Email */}
        <div className="mb-5">
          <label htmlFor="email" className="mb-1.5 block text-sm font-medium text-text">
            Email address
          </label>
          <input
            className="h-[var(--input-height)] w-full rounded-input border border-outline-variant bg-surface-container-lowest px-3 font-body text-base text-text placeholder:text-text-muted focus:border-primary focus:shadow-ring focus:outline-none"
            type="email"
            id="email"
            name="email"
            placeholder="you@organisation.org"
            autoComplete="email"
            required
          />
        </div>

        {/* Password */}
        <div className="mb-6">
          <label htmlFor="password" className="mb-1.5 block text-sm font-medium text-text">
            Password
          </label>
          <div className="relative">
            <input
              className="h-[var(--input-height)] w-full rounded-input border border-outline-variant bg-surface-container-lowest px-3 pr-10 font-body text-base text-text placeholder:text-text-muted focus:border-primary focus:shadow-ring focus:outline-none"
              type={showPassword ? "text" : "password"}
              id="password"
              name="password"
              placeholder="Your password"
              autoComplete="current-password"
              required
            />
            <button
              type="button"
              aria-label={showPassword ? "Hide password" : "Show password"}
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 border-none bg-transparent p-1 text-sm leading-none text-text-muted transition-colors duration-normal ease-out hover:text-text-secondary"
            >
              {showPassword ? "Hide" : "Show"}
            </button>
          </div>
        </div>

        {/* Submit */}
        <button
          type="submit"
          className="inline-flex h-[var(--btn-height-lg)] w-full items-center justify-center gap-2 rounded-button border-none bg-primary px-8 font-body text-base font-medium text-on-primary transition-opacity duration-normal ease-out hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          Sign in
        </button>
      </form>

      {/* Forgot password link */}
      <div className="mt-5 text-center">
        <Link
          href="/forgot-password"
          className="text-sm font-medium text-primary no-underline transition-colors duration-normal ease-out hover:text-primary-dark hover:underline"
        >
          Forgot password?
        </Link>
      </div>

      {/* Divider */}
      <div className="my-6 flex items-center gap-4">
        <div className="h-px flex-1 bg-border" />
        <span className="text-xs font-medium lowercase text-text-muted">or</span>
        <div className="h-px flex-1 bg-border" />
      </div>

      {/* SSO Button */}
      <button
        type="button"
        onClick={handleSSOLogin}
        className="inline-flex h-[var(--btn-height-lg)] w-full items-center justify-center gap-2 rounded-button bg-surface-container-highest px-8 font-body text-base font-medium text-on-surface transition-colors duration-normal ease-out hover:bg-surface-dim focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        <GoogleIcon />
        SSO Login (Google Workspace)
      </button>

      {/* Request access */}
      <div className="mt-6 border-t border-neutral-100 pt-6 text-center">
        <p className="text-sm text-text-secondary">
          Don&apos;t have an account?{" "}
          <Link
            href="/request-access"
            className="font-medium text-primary no-underline transition-colors duration-normal ease-out hover:text-primary-dark hover:underline"
          >
            Request access
          </Link>
        </p>
      </div>
    </AuthCard>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
