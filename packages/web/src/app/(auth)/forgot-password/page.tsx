"use client";

import { ArrowLeft, Mail } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { AuthCard } from "@/components/auth/auth-card";
import { AuthLogo } from "@/components/auth/auth-logo";

/**
 * Forgot password page — matches AUTH-003 mockup (docs/design/auth/forgot-password.html).
 * Two states: form (email input) and success (confirmation message).
 *
 * In Phase 1 this redirects to Keycloak's reset-credentials flow.
 * The form UI is kept for when a custom password reset flow is implemented.
 */
export default function ForgotPasswordPage() {
  const [submitted, setSubmitted] = useState(false);

  if (submitted) {
    return (
      <AuthCard>
        <AuthLogo />
        <div className="py-6 text-center">
          {/* Success icon — circular primary-50 bg with mail symbol */}
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-primary-50 text-primary">
            <Mail className="h-7 w-7" />
          </div>
          <h2 className="mb-2 font-heading text-lg text-text">Email sent</h2>
          <p className="mx-auto mb-6 max-w-[320px] text-sm leading-relaxed text-text-secondary">
            If an account is associated with this address, you will receive a reset link shortly.
            Check your spam folder.
          </p>
          <Link
            href="/login"
            className="inline-flex h-[var(--btn-height-lg)] w-full items-center justify-center rounded-button bg-primary px-8 text-base font-medium text-on-primary no-underline transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            Back to sign in
          </Link>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard>
      <AuthLogo />

      <h1 className="mb-2 text-center font-heading text-xl text-text">Forgot password</h1>
      <p className="mb-6 text-center text-sm text-text-secondary">
        Enter your email address to receive a reset link.
      </p>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          // Phase 1: redirect to Keycloak reset-credentials flow
          const keycloakUrl = process.env.NEXT_PUBLIC_KEYCLOAK_URL ?? "http://localhost:8080";
          const realm = process.env.NEXT_PUBLIC_KEYCLOAK_REALM ?? "givernance";
          const clientId = process.env.NEXT_PUBLIC_KEYCLOAK_CLIENT_ID ?? "givernance-web";
          const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

          const params = new URLSearchParams({
            client_id: clientId,
            redirect_uri: `${appUrl}/login`,
            kc_action: "UPDATE_PASSWORD",
          });

          window.location.href = `${keycloakUrl}/realms/${realm}/protocol/openid-connect/auth?${params.toString()}`;

          // Show success state as fallback (in case redirect is slow)
          setSubmitted(true);
        }}
        noValidate
      >
        <div className="mb-6">
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

        <button
          type="submit"
          className="inline-flex h-[var(--btn-height-lg)] w-full items-center justify-center rounded-button bg-primary px-8 text-base font-medium text-on-primary transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          Send reset link
        </button>
      </form>

      <p className="mt-4 text-center text-xs leading-relaxed text-text-secondary">
        An email will be sent with a reset link valid for 1 hour.
      </p>

      {/* Back to login */}
      <div className="mt-5 text-center">
        <Link
          href="/login"
          className="text-sm font-medium text-primary no-underline transition-colors hover:text-primary-dark hover:underline"
        >
          <ArrowLeft className="inline h-3.5 w-3.5" /> Back to sign in
        </Link>
      </div>
    </AuthCard>
  );
}
