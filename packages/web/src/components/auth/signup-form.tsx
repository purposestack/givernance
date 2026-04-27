"use client";

/**
 * Self-serve signup form (issue #109 / ADR-016 / doc 22 §6.1).
 *
 * The onboarding form now follows the shared Night Shift primitives:
 * - `Form` + `FormField` + `FormMessage` for validation and field layout
 * - `FormSection` for the editorial two-column structure
 *
 * We still keep the bespoke signup logic here because the API contract is
 * intentionally slim and includes client-side affordances like slug derivation,
 * email lookup hints, and the temporary hCaptcha bridge.
 */

import { isReservedSlug, validateTenantDomain } from "@givernance/shared/constants";
import {
  LOCALE_NATIVE_NAMES,
  type Locale,
  localeFromCountry,
  SUPPORTED_LOCALES,
} from "@givernance/shared/i18n";
import { validateTenantSlug } from "@givernance/shared/validators";
import { ShieldCheck, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useForm } from "react-hook-form";

import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/shared/form-field";
import { FormSection } from "@/components/shared/form-section";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { lookupTenant, submitSignup } from "@/services/SignupService";

interface SignupFormProps {
  /** Pre-filled country ISO-2 from IP geolocation if the server resolved it. */
  defaultCountry?: string;
  /** hCaptcha site key — when omitted the widget is not rendered (dev mode). */
  captchaSiteKey?: string;
}

interface SignupFormValues {
  orgName: string;
  slug: string;
  firstName: string;
  lastName: string;
  email: string;
  country: string;
  /**
   * BCP-47 locale for the new tenant (issue #153). Default derived from
   * `country` so e.g. an FR signup pre-selects French; the user can flip
   * to EN before submit. Mirrors the backend `localeFromCountry` rule.
   */
  locale: Locale;
  legalType: LegalType;
  consent: boolean;
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

  const errorSummaryId = useId();
  const summaryRef = useRef<HTMLDivElement>(null);

  const form = useForm<SignupFormValues>({
    mode: "onBlur",
    defaultValues: {
      orgName: "",
      slug: "",
      firstName: "",
      lastName: "",
      email: "",
      country: defaultCountry,
      locale: localeFromCountry(defaultCountry),
      legalType: "association",
      consent: false,
    },
  });

  const orgNameValue = form.watch("orgName");
  const slugValue = form.watch("slug");
  const emailValue = form.watch("email");
  const countryValue = form.watch("country");

  // React Hook Form already tracks "the user has modified this field" via
  // `formState.dirtyFields`. We don't shadow that with parallel `useState`
  // flags — the auto-derive effects below read RHF's source of truth
  // directly, so a missed `setXxxDirty(true)` call can't desynchronise.
  // Both auto-derives (orgName→slug and country→locale) call setValue
  // with `shouldDirty: false`, so RHF never marks them dirty on its own;
  // only the user's `field.onChange` flips the flag. (PR #158 review.)
  const slugDirty = Boolean(form.formState.dirtyFields.slug);
  const localeDirty = Boolean(form.formState.dirtyFields.locale);
  const [slugState, setSlugState] = useState<SlugState>({ kind: "idle" });
  const [captchaToken, setCaptchaToken] = useState<string | undefined>();
  const [emailHint, setEmailHint] = useState<string | undefined>();
  const [focusErrorSummary, setFocusErrorSummary] = useState(0);

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

  useEffect(() => {
    if (focusErrorSummary > 0) summaryRef.current?.focus();
  }, [focusErrorSummary]);

  useEffect(() => {
    if (!slugDirty) {
      // Auto-derivation must not force validation: on mount `orgName` is
      // empty, which would surface the slugSyntax error before the user has
      // touched the field. Validation still runs on blur (form mode) and on
      // submit; the `slugState` effect below provides live, non-error hints
      // while the user is typing.
      form.setValue("slug", slugify(orgNameValue), {
        shouldDirty: false,
        shouldValidate: false,
      });
    }
  }, [form, orgNameValue, slugDirty]);

  useEffect(() => {
    if (slugValue.length < 2) {
      setSlugState({ kind: "idle" });
      return;
    }
    const slugCheck = validateTenantSlug(slugValue);
    if (!slugCheck.ok) {
      setSlugState({ kind: "invalid", reason: slugCheck.reason });
      return;
    }
    if (isReservedSlug(slugValue)) {
      setSlugState({ kind: "invalid", reason: "reserved" });
      return;
    }
    setSlugState({ kind: "idle" });
  }, [slugValue]);

  // Issue #153: keep the locale picker in sync with country changes until
  // the user explicitly picks a locale. Removes the surprising "I changed
  // country to DE but the picker still says French" UX flagged in PR #158
  // platform review (F-P5).
  useEffect(() => {
    if (localeDirty) return;
    const nextLocale = localeFromCountry(countryValue);
    if (form.getValues("locale") !== nextLocale) {
      form.setValue("locale", nextLocale, { shouldDirty: false, shouldValidate: false });
    }
  }, [countryValue, form, localeDirty]);

  useEffect(() => {
    if (!emailValue.includes("@")) {
      setEmailHint(undefined);
      return;
    }

    let cancelled = false;
    const handle = setTimeout(async () => {
      const look = await lookupTenant(emailValue);
      if (cancelled) return;
      setEmailHint(look?.hasExistingTenant ? t("emailHasTenant") : undefined);
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [emailValue, t]);

  const focusSummary = useCallback(() => {
    setFocusErrorSummary((count) => count + 1);
  }, []);

  const handleSubmit = useCallback(
    async (values: SignupFormValues) => {
      form.clearErrors("root");

      if (captchaSiteKey && !captchaToken) {
        form.setError("root", {
          type: "manual",
          message: t("errors.captchaRequired"),
        });
        focusSummary();
        return;
      }

      const res = await submitSignup({
        orgName: values.orgName.trim(),
        slug: values.slug.trim(),
        firstName: values.firstName.trim(),
        lastName: values.lastName.trim(),
        email: values.email.trim().toLowerCase(),
        country: values.country,
        locale: values.locale,
        captchaToken,
      });

      if (res.ok) {
        const params = new URLSearchParams({ email: res.data.email });
        router.push(`/signup/success?${params.toString()}`);
        return;
      }

      switch (res.error.kind) {
        case "slug_taken":
          form.setError("slug", {
            type: "server",
            message: t("errors.slugTaken"),
          });
          setSlugState({ kind: "taken" });
          break;
        case "email_in_use":
          form.setError("email", {
            type: "server",
            message: t("errors.emailInUse"),
          });
          break;
        case "invalid_slug":
          form.setError("slug", {
            type: "server",
            message: t("errors.slugSyntax"),
          });
          break;
        case "captcha":
          form.setError("root", {
            type: "server",
            message: t("errors.captchaInvalid"),
          });
          break;
        case "rate_limited":
          form.setError("root", {
            type: "server",
            message: t("errors.rateLimited"),
          });
          break;
        default:
          form.setError("root", {
            type: "server",
            message: t("errors.generic"),
          });
      }

      focusSummary();
    },
    [captchaSiteKey, captchaToken, focusSummary, form, router, t],
  );

  const fieldErrors = Object.entries(form.formState.errors).flatMap(([field, error]) => {
    if (field === "root" || typeof error?.message !== "string") {
      return [];
    }
    return [error.message];
  });

  const rootError = form.formState.errors.root?.message;
  const hasAnyError = Boolean(rootError) || fieldErrors.length > 0;
  const isSubmitting = form.formState.isSubmitting;

  return (
    <Form {...form}>
      <form
        noValidate
        onSubmit={form.handleSubmit(handleSubmit, focusSummary)}
        aria-describedby={hasAnyError ? errorSummaryId : undefined}
        className="space-y-0 overflow-hidden"
      >
        {hasAnyError ? (
          <div
            ref={summaryRef}
            id={errorSummaryId}
            tabIndex={-1}
            role="alert"
            aria-live="polite"
            className="mb-6 flex items-start gap-3 rounded-lg border border-error-border bg-error-container p-3 text-sm text-on-error-container"
          >
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <div className="flex-1 space-y-1">
              {rootError ? <p>{rootError}</p> : null}
              {fieldErrors.length > 0 ? (
                <ul className="list-inside list-disc">
                  {fieldErrors.map((message) => (
                    <li key={message}>{message}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          </div>
        ) : null}

        <FormSection
          title={t("sections.workspace.title")}
          description={t("sections.workspace.description")}
          className="py-0 pb-8"
        >
          <div className="grid gap-5 lg:grid-cols-2">
            <FormField
              control={form.control}
              name="orgName"
              rules={{
                validate: (value) => value.trim().length >= 2 || t("errors.orgNameRequired"),
              }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>{t("fields.orgName")}</FormLabel>
                  <FormControl>
                    <Input {...field} autoComplete="organization" maxLength={255} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="slug"
              rules={{
                validate: (value) => {
                  const slugCheck = validateTenantSlug(value);
                  if (!slugCheck.ok) {
                    return slugCheck.reason === "reserved"
                      ? t("errors.slugReserved")
                      : slugCheck.reason === "punycode"
                        ? t("errors.slugPunycode")
                        : t("errors.slugSyntax");
                  }
                  if (isReservedSlug(value)) {
                    return t("errors.slugReserved");
                  }
                  return true;
                },
              }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>{t("fields.slug")}</FormLabel>
                  <div className="flex flex-col gap-2">
                    <span className="shrink-0 text-sm text-text-muted">givernance.app/</span>
                    <FormControl>
                      <Input
                        {...field}
                        maxLength={50}
                        pattern="^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$"
                        onChange={(event) => {
                          // RHF marks the field dirty automatically via
                          // field.onChange — `dirtyFields.slug` flips here,
                          // which the auto-derive effect above reads.
                          field.onChange(event.target.value.toLowerCase());
                        }}
                      />
                    </FormControl>
                  </div>
                  <p className="text-xs text-text-muted">
                    {slugState.kind === "taken" ? (
                      <span className="text-error">{t("slug.taken")}</span>
                    ) : null}
                    {slugState.kind === "invalid" ? (
                      <span className="text-error">
                        {slugState.reason === "reserved"
                          ? t("errors.slugReserved")
                          : slugState.reason === "punycode"
                            ? t("errors.slugPunycode")
                            : t("errors.slugSyntax")}
                      </span>
                    ) : null}
                    {slugState.kind === "idle" ? t("slug.help") : null}
                  </p>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </FormSection>

        <FormSection
          title={t("sections.contact.title")}
          description={t("sections.contact.description")}
        >
          <div className="grid gap-5 lg:grid-cols-2">
            <FormField
              control={form.control}
              name="firstName"
              rules={{
                validate: (value) => value.trim().length >= 1 || t("errors.firstNameRequired"),
              }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>{t("fields.firstName")}</FormLabel>
                  <FormControl>
                    <Input {...field} autoComplete="given-name" maxLength={255} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="lastName"
              rules={{
                validate: (value) => value.trim().length >= 1 || t("errors.lastNameRequired"),
              }}
              render={({ field }) => (
                <FormItem>
                  <FormLabel required>{t("fields.lastName")}</FormLabel>
                  <FormControl>
                    <Input {...field} autoComplete="family-name" maxLength={255} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="email"
              rules={{
                validate: (value) => {
                  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) {
                    return t("errors.emailInvalid");
                  }
                  const domain = value.split("@")[1] ?? "";
                  const trimmed = validateTenantDomain(domain);
                  if (!trimmed.ok && trimmed.reason === "too_long") {
                    return t("errors.emailInvalid");
                  }
                  return true;
                },
              }}
              render={({ field }) => (
                <FormItem className="lg:col-span-2">
                  <FormLabel required>{t("fields.email")}</FormLabel>
                  <FormControl>
                    <Input {...field} type="email" autoComplete="email" maxLength={255} />
                  </FormControl>
                  {emailHint ? <p className="text-xs text-text-secondary">{emailHint}</p> : null}
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="country"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("fields.country")}</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      maxLength={2}
                      minLength={2}
                      onChange={(event) =>
                        field.onChange(event.target.value.toUpperCase().slice(0, 2))
                      }
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/*
             * Issue #153 — locale picker. Default derived from `country` at
             * mount via `localeFromCountry`; the user can flip it before
             * submit. The API stores the chosen value as
             * `tenants.default_locale` and the picker labels update when
             * the user re-renders the form in another locale.
             */}
            <FormField
              control={form.control}
              name="locale"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("fields.locale")}</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={(value) => {
                      // RHF flips `dirtyFields.locale` via field.onChange
                      // when the picked value differs from the default.
                      // The country→locale auto-derive effect reads that
                      // flag directly. Note: clicking the same value as
                      // the default doesn't count as expressing a
                      // preference (auto-derive resumes on country change)
                      // — that's deliberate per the PR #158 design discussion.
                      field.onChange(value as Locale);
                    }}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {SUPPORTED_LOCALES.map((locale) => (
                        // Endonym — each name in its own script so the
                        // picker is always self-readable. See
                        // LOCALE_NATIVE_NAMES docblock for rationale.
                        <SelectItem key={locale} value={locale}>
                          {LOCALE_NATIVE_NAMES[locale]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="legalType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("fields.legalType")}</FormLabel>
                  <Select value={field.value} onValueChange={(value) => field.onChange(value)}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {LEGAL_TYPES.map((legalType) => (
                        <SelectItem key={legalType.value} value={legalType.value}>
                          {t(legalType.labelKey)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </FormSection>

        <FormSection
          title={t("sections.security.title")}
          description={t("sections.security.description")}
          className="border-b-0 pb-0"
        >
          <div className="space-y-5">
            <FormField
              control={form.control}
              name="consent"
              rules={{
                validate: (value) => value || t("errors.consentRequired"),
              }}
              render={({ field }) => (
                <FormItem>
                  <div className="flex items-start gap-3 rounded-xl border border-outline-variant bg-surface-container-low p-4">
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={(checked) => field.onChange(checked === true)}
                        className="mt-0.5"
                      />
                    </FormControl>
                    <div className="space-y-1">
                      <FormLabel required className="mb-0">
                        {t("sections.security.consentLabel")}
                      </FormLabel>
                      <p className="text-sm text-on-surface-variant">
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
                      </p>
                      <FormMessage />
                    </div>
                  </div>
                </FormItem>
              )}
            />

            {captchaSiteKey ? (
              <fieldset
                data-sitekey={captchaSiteKey}
                className="h-cap-container rounded-xl border border-dashed border-outline-variant bg-surface-container-low p-4"
              >
                <legend className="sr-only">{t("captchaLabel")}</legend>
              </fieldset>
            ) : null}

            <div className="flex items-center gap-2 text-sm text-on-surface-variant">
              <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />
              <span>{t("securityHint")}</span>
            </div>
          </div>
        </FormSection>

        <div className="flex flex-col gap-4 pt-8">
          <Button type="submit" size="lg" disabled={isSubmitting} className="w-full">
            {isSubmitting ? tCommon("actions.submitting") : t("submit")}
          </Button>

          <div className="border-t border-outline-variant pt-6 text-center text-sm text-text-secondary">
            {t.rich("haveAccount", {
              link: (chunks) => (
                <Link
                  href="/login"
                  className="font-medium text-primary transition-colors duration-normal ease-out hover:underline"
                >
                  {chunks}
                </Link>
              ),
            })}
          </div>
        </div>
      </form>
    </Form>
  );
}
