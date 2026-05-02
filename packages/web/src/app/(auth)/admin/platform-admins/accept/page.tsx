"use client";

import { CheckCircle2, LogOut, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { type FormEvent, Suspense, useCallback, useEffect, useId, useState } from "react";
import { AuthCard } from "@/components/auth/auth-card";
import { AuthLogo } from "@/components/auth/auth-logo";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  acceptPlatformAdminInvitation,
  probePlatformAdminInvitation,
} from "@/services/PlatformAdminInvitationService";

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
 * One-shot probe of `/v1/users/me` — same posture as the team-invite
 * accept page. The (auth) layout deliberately doesn't mount AuthProvider,
 * so we probe inline here to detect the "already signed in as someone
 * else" case (the exact UX gap that issue #254's KC `execute-actions-email`
 * approach couldn't solve).
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
 * Platform-admin invitation accept page (issue #254 fix-commit 4 refactor).
 *
 * Public — not behind the (admin) super_admin gate. Replaces the prior
 * KC `execute-actions-email` flow that couldn't gracefully handle:
 *   1. The KC_RESTART cookie expiring during password set.
 *   2. KC's "Restart login cookie not found" page after UPDATE_PASSWORD.
 *   3. KC's "already authenticated as different user" rejection when an
 *      operator clicks the email while still logged in.
 *
 * The Givernance-side accept page handles all three: pre-flight token
 * probe + session-conflict detection + post-accept redirect to /login.
 */
function AcceptContent() {
  const t = useTranslations("auth.platformAdminAccept");
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
  const [firstNameDirty, setFirstNameDirty] = useState(false);
  const [lastNameDirty, setLastNameDirty] = useState(false);
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "done">("idle");
  const [error, setError] = useState<string | undefined>();
  const [errorKind, setErrorKind] = useState<
    "validation" | "expired" | "conflict" | "generic" | undefined
  >();
  const [session, setSession] = useState<SessionProbe>({ status: "checking" });
  type TokenProbeState = "checking" | "valid" | "invalid";
  const [tokenProbe, setTokenProbe] = useState<TokenProbeState>("checking");

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void probeSession().then((next) => {
      if (!cancelled) setSession(next);
    });
    void probePlatformAdminInvitation(token).then((result) => {
      if (cancelled) return;
      if (result.kind === "valid") {
        setTokenProbe("valid");
        if (!firstNameDirty && result.data.firstName) setFirstName(result.data.firstName);
        if (!lastNameDirty && result.data.lastName) setLastName(result.data.lastName);
      } else {
        setTokenProbe("invalid");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [firstNameDirty, lastNameDirty, token]);

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
        setErrorKind("validation");
        setError(t(`errors.${validation}`, { min: PASSWORD_MIN_LENGTH }));
        return;
      }
      setStatus("submitting");
      setError(undefined);
      setErrorKind(undefined);
      const res = await acceptPlatformAdminInvitation(
        token,
        firstName.trim(),
        lastName.trim(),
        password,
      );
      if (res.ok) {
        setStatus("done");
        // Fresh OIDC code flow with the just-set credential.
        window.location.href = "/api/auth/login";
        return;
      }
      setStatus("idle");
      const errorKey = res.status === 404 ? "expired" : res.status === 409 ? "conflict" : "generic";
      setErrorKind(errorKey);
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
        <h1 className="mb-2 text-center font-heading text-xl text-on-surface">{t("errorTitle")}</h1>
        <p className="mb-6 text-center text-sm text-on-surface-variant">
          {t("errors.missingToken")}
        </p>
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
        <h1 className="mb-2 text-center font-heading text-xl text-on-surface">
          {t("successTitle")}
        </h1>
        <p className="mb-6 text-center text-sm text-on-surface-variant">{t("successBody")}</p>
        <div className="flex items-center justify-center text-xs text-on-surface-variant">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      </AuthCard>
    );
  }

  if (session.status === "checking" || tokenProbe === "checking") {
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

  // Session-conflict branch — same fix #154 used for team invites. The
  // sign-out prompt MUST take precedence so a different-user session
  // doesn't survive into the post-accept login redirect.
  if (session.status === "signed_in") {
    const returnTo = `/admin/platform-admins/accept?token=${encodeURIComponent(token)}`;
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
        <h1 className="mb-2 text-center font-heading text-xl text-on-surface">
          {t("sessionCheck.title")}
        </h1>
        <p className="mb-2 text-center text-sm text-on-surface-variant">
          {t("sessionCheck.signedInAs", { name: displayName, email: session.user.email })}
        </p>
        <p className="mb-6 text-center text-sm text-on-surface-variant">{t("sessionCheck.body")}</p>
        <form method="POST" action="/api/auth/logout" className="space-y-3">
          <input type="hidden" name="return_to" value={returnTo} />
          <button
            type="submit"
            className="inline-flex h-[var(--btn-height-lg)] w-full items-center justify-center gap-2 rounded-button bg-primary px-8 font-body text-base font-medium text-on-primary transition-opacity duration-normal ease-out hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
            {t("sessionCheck.signOut")}
          </button>
        </form>
      </AuthCard>
    );
  }

  if (tokenProbe === "invalid" || errorKind === "expired") {
    return (
      <AuthCard>
        <AuthLogo />
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-error-container text-on-error-container">
          <TriangleAlert className="h-6 w-6" aria-hidden="true" />
        </div>
        <h1 className="mb-2 text-center font-heading text-xl text-on-surface">{t("errorTitle")}</h1>
        <p className="mb-6 text-center text-sm text-on-surface-variant">{t("errors.expired")}</p>
        <Link
          href="/login"
          className="inline-flex h-[var(--btn-height-md)] w-full items-center justify-center rounded-button bg-primary px-6 text-sm font-medium text-on-primary"
        >
          {t("backToLogin")}
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard>
      <AuthLogo />
      <h1 className="mb-2 text-center font-heading text-xl text-on-surface">{t("title")}</h1>
      <p className="mb-6 text-center text-sm text-on-surface-variant">{t("subtitle")}</p>
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div>
          <Label htmlFor={ids.firstName}>{t("fields.firstName")}</Label>
          <Input
            id={ids.firstName}
            value={firstName}
            onChange={(e) => {
              setFirstName(e.target.value);
              setFirstNameDirty(true);
            }}
            required
            autoComplete="given-name"
          />
        </div>
        <div>
          <Label htmlFor={ids.lastName}>{t("fields.lastName")}</Label>
          <Input
            id={ids.lastName}
            value={lastName}
            onChange={(e) => {
              setLastName(e.target.value);
              setLastNameDirty(true);
            }}
            required
            autoComplete="family-name"
          />
        </div>
        <div>
          <Label htmlFor={ids.password}>{t("fields.password")}</Label>
          <Input
            id={ids.password}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={PASSWORD_MIN_LENGTH}
            autoComplete="new-password"
          />
          <p className="mt-1 text-xs text-on-surface-variant">
            {t("fields.passwordHint", { min: PASSWORD_MIN_LENGTH })}
          </p>
        </div>
        <div>
          <Label htmlFor={ids.passwordConfirm}>{t("fields.passwordConfirm")}</Label>
          <Input
            id={ids.passwordConfirm}
            type="password"
            value={passwordConfirm}
            onChange={(e) => setPasswordConfirm(e.target.value)}
            required
            minLength={PASSWORD_MIN_LENGTH}
            autoComplete="new-password"
          />
        </div>
        {error ? (
          <p
            role="alert"
            className="rounded-md bg-error-container p-3 text-sm text-on-error-container"
          >
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={status === "submitting"}
          className="inline-flex h-[var(--btn-height-lg)] w-full items-center justify-center rounded-button bg-primary px-8 font-body text-base font-medium text-on-primary transition-opacity duration-normal ease-out hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60"
        >
          {status === "submitting" ? t("submitting") : t("submit")}
        </button>
      </form>
    </AuthCard>
  );
}

export default function PlatformAdminAcceptPage() {
  return (
    <Suspense
      fallback={
        <AuthCard>
          <AuthLogo />
          <div className="flex items-center justify-center py-6">
            <span
              role="status"
              className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent"
            />
          </div>
        </AuthCard>
      }
    >
      <AcceptContent />
    </Suspense>
  );
}
