"use client";

import { CheckCircle2, LogIn, LogOut, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { type FormEvent, Suspense, useCallback, useEffect, useId, useState } from "react";
import { AuthCard } from "@/components/auth/auth-card";
import { AuthLogo } from "@/components/auth/auth-logo";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { acceptInvitation } from "@/services/InvitationService";

const PASSWORD_MIN_LENGTH = 12;
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";

interface SignedInUser {
  email: string;
  firstName?: string;
  lastName?: string;
}

type SessionProbe =
  | { status: "checking" }
  | { status: "anonymous" }
  | { status: "signed_in"; user: SignedInUser };

/**
 * One-shot probe of `/v1/users/me` to detect whether the invitee landed on
 * this page while another user is still signed in (e.g. a multi-tenant
 * teammate clicking the link from their email while logged into a sibling
 * tenant — see PR #154 follow-up). The `(auth)` route group deliberately
 * doesn't mount `AuthProvider`, so we do the probe inline here.
 */
async function probeSession(): Promise<SessionProbe> {
  try {
    const res = await fetch(`${API_URL}/v1/users/me`, { credentials: "include" });
    if (!res.ok) return { status: "anonymous" };
    const body = (await res.json()) as { data?: SignedInUser };
    if (!body.data?.email) return { status: "anonymous" };
    return { status: "signed_in", user: body.data };
  } catch {
    return { status: "anonymous" };
  }
}

type ValidationKey = "invalid" | "namesRequired" | "passwordTooShort" | "passwordMismatch";

interface AcceptFormFields {
  token: string;
  firstName: string;
  lastName: string;
  password: string;
  passwordConfirm: string;
}

function validateAcceptForm(f: AcceptFormFields): ValidationKey | null {
  if (!f.token) return "invalid";
  if (f.firstName.trim().length < 1 || f.lastName.trim().length < 1) return "namesRequired";
  if (f.password.length < PASSWORD_MIN_LENGTH) return "passwordTooShort";
  if (f.password !== f.passwordConfirm) return "passwordMismatch";
  return null;
}

/**
 * Team-invite accept landing (issue #145).
 *
 * Mirrors `/signup/verify` — collects firstName, lastName, and password
 * for the invitee, then redirects through Keycloak login. The API has
 * already provisioned the realm user + Organization membership + the
 * `org_id` / `role` user attributes that the realm's mapper turns into
 * the JWT claims the auth callback requires.
 *
 * Failure modes are intentionally collapsed to a single 410 by the API
 * (no enumeration oracle). The UI shows a static "ask the inviter to
 * resend" copy for that case rather than a self-serve resend form: the
 * resend endpoint is org_admin-only in the team-invite flow, unlike the
 * signup-verification resend which is public-with-rate-limit.
 */
function AcceptContent() {
  const t = useTranslations("auth.inviteAccept");
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
  const [session, setSession] = useState<SessionProbe>({ status: "checking" });

  // Session-detection probe (PR #154 follow-up). Held off the form render
  // until we know whether another user is already signed in — otherwise an
  // invitee could fill the form, hit the login redirect, and silently bounce
  // back into the previous user's session.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void probeSession().then((next) => {
      if (!cancelled) setSession(next);
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const handleSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const validation = validateAcceptForm({
        token,
        firstName,
        lastName,
        password,
        passwordConfirm,
      });
      if (validation) {
        setError(t(`errors.${validation}`, { min: PASSWORD_MIN_LENGTH }));
        return;
      }
      setStatus("submitting");
      setError(undefined);
      const res = await acceptInvitation(token, firstName.trim(), lastName.trim(), password);
      if (res.ok) {
        setStatus("done");
        // Redirect to Keycloak login. The API has already attached us as
        // an Organization member and stamped the `org_id` user attribute
        // that the realm's mapper turns into the JWT claim the callback
        // requires.
        //
        // NOTE: `?hint=<slug>` is currently a no-op — the `/api/auth/login`
        // route handler doesn't read query params, so the slug round-trip
        // doesn't actually drive `kc_idp_hint`/`login_hint`. Kept for
        // structural parity with `/signup/verify` (same dead query string)
        // until both can be wired or removed together. Tracked as a
        // follow-up to issue #145 (review F1).
        window.location.href = `/api/auth/login?hint=${encodeURIComponent(res.data.slug)}`;
        return;
      }
      setStatus("idle");
      const errorKey =
        res.status === 410 ? "expired" : res.status === 429 ? "rateLimited" : "generic";
      setError(t(`errors.${errorKey}`));
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
          href="/login"
          className="inline-flex h-[var(--btn-height-md)] w-full items-center justify-center rounded-button bg-primary px-6 text-sm font-medium text-on-primary"
        >
          {t("backToLogin")}
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

  if (session.status === "checking") {
    return (
      <AuthCard>
        <AuthLogo />
        <div className="flex items-center justify-center py-6">
          <span
            role="status"
            aria-label={t("sessionCheck.checking")}
            className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent"
          />
        </div>
      </AuthCard>
    );
  }

  if (session.status === "signed_in") {
    const returnTo = `/invite/accept?token=${encodeURIComponent(token)}`;
    const displayName =
      session.user.firstName || session.user.lastName
        ? [session.user.firstName, session.user.lastName].filter(Boolean).join(" ")
        : session.user.email;
    return (
      <AuthCard>
        <AuthLogo />
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary-50 text-primary">
          <LogOut className="h-6 w-6" aria-hidden="true" />
        </div>
        <h1 className="mb-2 text-center font-heading text-xl text-text">
          {t("sessionCheck.title")}
        </h1>
        <p className="mb-2 text-center text-sm text-text-secondary">
          {t("sessionCheck.signedInAs", { name: displayName, email: session.user.email })}
        </p>
        <p className="mb-6 text-center text-sm text-text-secondary">{t("sessionCheck.body")}</p>
        <form method="POST" action="/api/auth/logout" className="space-y-3">
          <input type="hidden" name="return_to" value={returnTo} />
          <button
            type="submit"
            className="inline-flex h-[var(--btn-height-lg)] w-full items-center justify-center gap-2 rounded-button bg-primary px-8 font-body text-base font-medium text-on-primary transition-opacity duration-normal ease-out hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
            {t("sessionCheck.signOutAndContinue")}
          </button>
        </form>
        <Link
          href="/dashboard"
          className="mt-3 inline-flex h-[var(--btn-height-md)] w-full items-center justify-center rounded-button border border-outline-variant bg-surface px-6 text-sm font-medium text-text"
        >
          {t("sessionCheck.keepCurrent")}
        </Link>
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

export default function InviteAcceptPage() {
  return (
    <Suspense
      fallback={
        <AuthCard>
          <span role="status">Loading…</span>
        </AuthCard>
      }
    >
      <AcceptContent />
    </Suspense>
  );
}
