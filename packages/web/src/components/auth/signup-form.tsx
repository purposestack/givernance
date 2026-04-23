"use client";

/**
 * Self-serve signup form (issue #109 / ADR-016 / doc 22 §6.1).
 *
 * Single-page form: org name, auto-derived editable slug, first/last name,
 * email, country (best-effort IP geolocation via the `geo` prop, editable),
 * legal type (doc 16), GDPR micro-consent, hCaptcha widget.
 *
 * The form is deliberately plain HTML (no react-hook-form) to keep the
 * bundle small on the first page the user lands on. Validation is
 * client-side with TypeBox-parity rules so the server-side 422 should only
 * fire on race conditions (e.g. slug taken between the debounced lookup and
 * the POST).
 */

import { isReservedSlug, validateTenantDomain } from "@givernance/shared/constants";
import { validateTenantSlug } from "@givernance/shared/validators";
import { LogIn, ShieldCheck, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type FormEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { lookupTenant, submitSignup } from "@/services/SignupService";

interface SignupFormProps {
  /** Pre-filled country ISO-2 from IP geolocation if the server resolved it. */
  defaultCountry?: string;
  /** hCaptcha site key — when omitted the widget is not rendered (dev mode). */
  captchaSiteKey?: string;
}

/** Strip accents + special chars → lowercase alnum-dash slug. */
function slugify(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

const LEGAL_TYPES = [
  { value: "association", labelKey: "legalTypes.association" },
  { value: "fondation", labelKey: "legalTypes.fondation" },
  { value: "fonds_de_dotation", labelKey: "legalTypes.fondsDeDotation" },
  { value: "cooperative", labelKey: "legalTypes.cooperative" },
  { value: "other", labelKey: "legalTypes.other" },
] as const;

type LegalType = (typeof LEGAL_TYPES)[number]["value"];

type SlugState =
  | { kind: "idle" }
  | { kind: "taken" }
  | { kind: "invalid"; reason: "syntax" | "reserved" | "punycode" };

export function SignupForm({ defaultCountry = "FR", captchaSiteKey }: SignupFormProps) {
  const t = useTranslations("auth.signup");
  const tCommon = useTranslations("common");
  const router = useRouter();

  const ids = {
    orgName: useId(),
    slug: useId(),
    firstName: useId(),
    lastName: useId(),
    email: useId(),
    country: useId(),
    legal: useId(),
    consent: useId(),
    errorSummary: useId(),
  };

  const [orgName, setOrgName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugDirty, setSlugDirty] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [country, setCountry] = useState(defaultCountry);
  const [legalType, setLegalType] = useState<LegalType>("association");
  const [consent, setConsent] = useState(false);
  const [captchaToken, setCaptchaToken] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | undefined>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [slugState, setSlugState] = useState<SlugState>({ kind: "idle" });
  // UX-1 fix: render-triggered focus so the ref is actually attached.
  const [focusErrorSummary, setFocusErrorSummary] = useState(0);

  const formRef = useRef<HTMLFormElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);

  // FE-5: expose the captcha-token setter on a known global so the external
  // hCaptcha script can call us on `onVerify`. Script-injection lands with
  // the infra PR — this side is ready.
  useEffect(() => {
    if (!captchaSiteKey) return;
    interface GlobalWithCaptcha {
      __gvCaptchaOnVerify?: (token: string) => void;
    }
    (globalThis as unknown as GlobalWithCaptcha).__gvCaptchaOnVerify = setCaptchaToken;
    return () => {
      (globalThis as unknown as GlobalWithCaptcha).__gvCaptchaOnVerify = undefined;
    };
  }, [captchaSiteKey]);

  // UX-1: after state updates that surface a new error, move focus to the
  // summary box (can't do it in the callback — the ref isn't attached yet).
  useEffect(() => {
    if (focusErrorSummary > 0) summaryRef.current?.focus();
  }, [focusErrorSummary]);

  // Auto-derive the slug from the org name until the user manually edits it.
  useEffect(() => {
    if (!slugDirty) setSlug(slugify(orgName));
  }, [orgName, slugDirty]);

  // FE-9 (PR #118 review): a real slug-availability endpoint ships with the
  // back-office (#111). Until then we do local syntax + reserved-slug checks
  // only and explicitly mark the state `idle` on a syntactically valid slug
  // — we never lie to the user with a green "available" tick we cannot back
  // up. The 409 fallback on submit still catches actual collisions.
  useEffect(() => {
    if (slug.length < 2) {
      setSlugState({ kind: "idle" });
      return;
    }
    const slugCheck = validateTenantSlug(slug);
    if (!slugCheck.ok) {
      setSlugState({ kind: "invalid", reason: slugCheck.reason });
      return;
    }
    if (isReservedSlug(slug)) {
      setSlugState({ kind: "invalid", reason: "reserved" });
      return;
    }
    setSlugState({ kind: "idle" });
  }, [slug]);

  // Debounced email lookup — nudge users toward their existing org.
  const [emailHint, setEmailHint] = useState<string | undefined>();
  useEffect(() => {
    if (!email.includes("@")) {
      setEmailHint(undefined);
      return;
    }
    const handle = setTimeout(async () => {
      const look = await lookupTenant(email);
      if (look?.hasExistingTenant) {
        setEmailHint(t("emailHasTenant"));
      } else {
        setEmailHint(undefined);
      }
    }, 400);
    return () => clearTimeout(handle);
  }, [email, t]);

  const clientSideErrors = useMemo(() => {
    const errs: Record<string, string> = {};
    if (orgName.trim().length < 2) errs.orgName = t("errors.orgNameRequired");
    const slugCheck = validateTenantSlug(slug);
    if (!slugCheck.ok) {
      errs.slug =
        slugCheck.reason === "reserved"
          ? t("errors.slugReserved")
          : slugCheck.reason === "punycode"
            ? t("errors.slugPunycode")
            : t("errors.slugSyntax");
    }
    if (firstName.trim().length < 1) errs.firstName = t("errors.firstNameRequired");
    if (lastName.trim().length < 1) errs.lastName = t("errors.lastNameRequired");
    // Cheap RFC 5321-ish pre-check; backend is the authoritative validator.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errs.email = t("errors.emailInvalid");
    else {
      const domain = email.split("@")[1] ?? "";
      // We intentionally DO NOT block personal-email domains here — the
      // self-serve track allows them. The domain validator is only used for
      // tenant-domain claims, never for signup.
      const trimmed = validateTenantDomain(domain);
      if (!trimmed.ok && trimmed.reason === "too_long") {
        errs.email = t("errors.emailInvalid");
      }
    }
    if (!consent) errs.consent = t("errors.consentRequired");
    return errs;
  }, [orgName, slug, firstName, lastName, email, consent, t]);

  const handleSubmit = useCallback(
    async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setSubmitError(undefined);

      if (Object.keys(clientSideErrors).length > 0) {
        setFieldErrors(clientSideErrors);
        setFocusErrorSummary((n) => n + 1);
        return;
      }

      if (captchaSiteKey && !captchaToken) {
        setSubmitError(t("errors.captchaRequired"));
        setFocusErrorSummary((n) => n + 1);
        return;
      }

      setSubmitting(true);
      try {
        const res = await submitSignup({
          orgName: orgName.trim(),
          slug: slug.trim(),
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: email.trim().toLowerCase(),
          country,
          captchaToken,
        });

        if (res.ok) {
          const params = new URLSearchParams({
            email: res.data.email,
          });
          router.push(`/signup/success?${params.toString()}`);
          return;
        }

        switch (res.error.kind) {
          case "slug_taken":
            setFieldErrors({ slug: t("errors.slugTaken") });
            setSlugState({ kind: "taken" });
            break;
          case "email_in_use":
            setFieldErrors({ email: t("errors.emailInUse") });
            break;
          case "invalid_slug":
            setFieldErrors({ slug: t("errors.slugSyntax") });
            break;
          case "captcha":
            setSubmitError(t("errors.captchaInvalid"));
            break;
          case "rate_limited":
            setSubmitError(t("errors.rateLimited"));
            break;
          default:
            setSubmitError(t("errors.generic"));
        }
        setFocusErrorSummary((n) => n + 1);
      } finally {
        setSubmitting(false);
      }
    },
    [
      clientSideErrors,
      captchaSiteKey,
      captchaToken,
      orgName,
      slug,
      firstName,
      lastName,
      email,
      country,
      t,
      router,
    ],
  );

  const hasAnyError = Object.keys(fieldErrors).length > 0 || submitError !== undefined;

  return (
    <form
      ref={formRef}
      noValidate
      onSubmit={handleSubmit}
      aria-describedby={hasAnyError ? ids.errorSummary : undefined}
      className="space-y-5"
    >
      {hasAnyError && (
        <div
          ref={summaryRef}
          id={ids.errorSummary}
          tabIndex={-1}
          role="alert"
          aria-live="polite"
          className="flex items-start gap-3 rounded-lg border border-error-border bg-error-container p-3 text-sm text-on-error-container"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="flex-1 space-y-1">
            {submitError && <p>{submitError}</p>}
            {Object.keys(fieldErrors).length > 0 && (
              <ul className="list-inside list-disc">
                {Object.entries(fieldErrors).map(([field, msg]) => (
                  <li key={field}>{msg}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <div>
        <Label htmlFor={ids.orgName} required>
          {t("fields.orgName")}
        </Label>
        <Input
          id={ids.orgName}
          name="orgName"
          autoComplete="organization"
          required
          value={orgName}
          onChange={(e) => setOrgName(e.target.value)}
          aria-invalid={fieldErrors.orgName ? "true" : undefined}
          aria-describedby={fieldErrors.orgName ? `${ids.orgName}-err` : undefined}
          maxLength={255}
        />
        {fieldErrors.orgName && (
          <p id={`${ids.orgName}-err`} className="mt-1 text-xs text-error">
            {fieldErrors.orgName}
          </p>
        )}
      </div>

      <div>
        <Label htmlFor={ids.slug} required>
          {t("fields.slug")}
        </Label>
        <div className="flex items-center gap-2">
          <span className="text-sm text-text-muted">givernance.app/</span>
          <Input
            id={ids.slug}
            name="slug"
            required
            value={slug}
            onChange={(e) => {
              setSlugDirty(true);
              setSlug(e.target.value.toLowerCase());
            }}
            aria-invalid={fieldErrors.slug ? "true" : undefined}
            aria-describedby={`${ids.slug}-help`}
            maxLength={50}
            pattern="^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$"
          />
        </div>
        <p id={`${ids.slug}-help`} className="mt-1 text-xs text-text-muted">
          {slugState.kind === "taken" && <span className="text-error">{t("slug.taken")}</span>}
          {slugState.kind === "invalid" && (
            <span className="text-error">
              {slugState.reason === "reserved"
                ? t("errors.slugReserved")
                : slugState.reason === "punycode"
                  ? t("errors.slugPunycode")
                  : t("errors.slugSyntax")}
            </span>
          )}
          {slugState.kind === "idle" && t("slug.help")}
        </p>
        {fieldErrors.slug && (
          <p id={`${ids.slug}-err`} className="mt-1 text-xs text-error">
            {fieldErrors.slug}
          </p>
        )}
      </div>

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
            aria-invalid={fieldErrors.firstName ? "true" : undefined}
            aria-describedby={fieldErrors.firstName ? `${ids.firstName}-err` : undefined}
            maxLength={255}
          />
          {fieldErrors.firstName && (
            <p id={`${ids.firstName}-err`} className="mt-1 text-xs text-error">
              {fieldErrors.firstName}
            </p>
          )}
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
            aria-invalid={fieldErrors.lastName ? "true" : undefined}
            aria-describedby={fieldErrors.lastName ? `${ids.lastName}-err` : undefined}
            maxLength={255}
          />
          {fieldErrors.lastName && (
            <p id={`${ids.lastName}-err`} className="mt-1 text-xs text-error">
              {fieldErrors.lastName}
            </p>
          )}
        </div>
      </div>

      <div>
        <Label htmlFor={ids.email} required>
          {t("fields.email")}
        </Label>
        <Input
          id={ids.email}
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={fieldErrors.email ? "true" : undefined}
          aria-describedby={
            [
              emailHint ? `${ids.email}-hint` : undefined,
              fieldErrors.email ? `${ids.email}-err` : undefined,
            ]
              .filter(Boolean)
              .join(" ") || undefined
          }
          maxLength={255}
        />
        {emailHint && (
          <p id={`${ids.email}-hint`} className="mt-1 text-xs text-text-secondary">
            {emailHint}
          </p>
        )}
        {fieldErrors.email && (
          <p id={`${ids.email}-err`} className="mt-1 text-xs text-error">
            {fieldErrors.email}
          </p>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor={ids.country}>{t("fields.country")}</Label>
          <Input
            id={ids.country}
            name="country"
            value={country}
            onChange={(e) => setCountry(e.target.value.toUpperCase().slice(0, 2))}
            maxLength={2}
            minLength={2}
          />
        </div>
        <div>
          <Label htmlFor={ids.legal}>{t("fields.legalType")}</Label>
          <select
            id={ids.legal}
            name="legalType"
            value={legalType}
            onChange={(e) => setLegalType(e.target.value as LegalType)}
            className="w-full h-[var(--input-height)] rounded-[var(--radius-input)] border border-outline-variant bg-surface-container-lowest px-3 text-sm"
          >
            {LEGAL_TYPES.map((lt) => (
              <option key={lt.value} value={lt.value}>
                {t(lt.labelKey)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <div className="flex items-start gap-3">
          <input
            id={ids.consent}
            name="consent"
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            aria-invalid={fieldErrors.consent ? "true" : undefined}
            aria-describedby={fieldErrors.consent ? `${ids.consent}-err` : undefined}
            className="mt-0.5 h-4 w-4 rounded border-outline-variant"
            required
          />
          <label htmlFor={ids.consent} className="text-xs text-text-secondary">
            {t.rich("consent", {
              privacy: (chunks) => (
                <Link href="/legal/privacy" className="text-primary underline">
                  {chunks}
                </Link>
              ),
              terms: (chunks) => (
                <Link href="/legal/terms" className="text-primary underline">
                  {chunks}
                </Link>
              ),
            })}
          </label>
        </div>
        {fieldErrors.consent && (
          <p id={`${ids.consent}-err`} className="mt-1 text-xs text-error">
            {fieldErrors.consent}
          </p>
        )}
      </div>

      {captchaSiteKey ? (
        // Placeholder container for the hCaptcha script to hydrate into
        // (arrives with the infra PR). Until then the backend fails open
        // in `CAPTCHA_MODE=disabled`, so no token is attached to submits.
        <fieldset data-sitekey={captchaSiteKey} className="h-cap-container border-0 p-0">
          <legend className="sr-only">{t("captchaLabel")}</legend>
        </fieldset>
      ) : null}

      <button
        type="submit"
        disabled={submitting}
        className="inline-flex h-[var(--btn-height-lg)] w-full items-center justify-center gap-2 rounded-button bg-primary px-8 font-body text-base font-medium text-on-primary transition-opacity duration-normal ease-out hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60"
      >
        {submitting ? (
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-on-primary border-t-transparent" />
        ) : (
          <LogIn className="h-4 w-4" aria-hidden="true" />
        )}
        {submitting ? tCommon("actions.submitting") : t("submit")}
      </button>

      <div className="mt-4 flex items-center justify-center gap-1.5 text-xs text-text-muted">
        <ShieldCheck className="h-3 w-3" aria-hidden="true" />
        <span>{t("securityHint")}</span>
      </div>

      <div className="mt-6 border-t border-neutral-100 pt-6 text-center">
        <p className="text-sm text-text-secondary">
          {t.rich("haveAccount", {
            link: (chunks) => (
              <Link href="/login" className="font-medium text-primary hover:underline">
                {chunks}
              </Link>
            ),
          })}
        </p>
      </div>
    </form>
  );
}
