"use client";

import { LOCALE_NATIVE_NAMES, type Locale, SUPPORTED_LOCALES } from "@givernance/shared/i18n";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { ApiProblem } from "@/lib/api";
import { createClientApiClient } from "@/lib/api/client-browser";
import type { MeProfile } from "@/models/user";
import { UserService } from "@/services/UserService";

/**
 * Sentinel value used by the locale Select to mean "no personal override — use
 * the tenant default". The API takes `locale: null` for the same intent;
 * we map between them at the form boundary.
 */
const FOLLOW_TENANT = "__follow_tenant__" as const;
type LocaleChoice = Locale | typeof FOLLOW_TENANT;

/**
 * Sentinel value used by the displayCurrency Select to mean "no personal
 * override — use the org's baseCurrency". The API takes `displayCurrency: null`.
 * ADR-031 §2.8, Epic #416 Task 7.
 *
 * TODO(ADR-031 task #409): fetch the enabled currency list from /v1/currencies
 * when that endpoint exists instead of using the hardcoded DISPLAY_CURRENCIES list.
 */
const FOLLOW_ORG_CURRENCY = "__follow_org__" as const;
type CurrencyChoice = string | typeof FOLLOW_ORG_CURRENCY;

/**
 * Hardcoded list of currencies offered in the display currency picker.
 * TODO(ADR-031 task #409): fetch from /v1/currencies when endpoint exists.
 */
const DISPLAY_CURRENCIES = ["EUR", "CHF", "GBP", "USD", "SEK", "NOK", "DKK", "PLN", "CZK"] as const;

function resolveApiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiProblem) {
    return error.detail ?? error.title ?? fallback;
  }
  return fallback;
}

interface ProfileLanguageFormProps {
  /**
   * Initial profile loaded server-side so the form renders synchronously
   * without a loading flash. The form re-fetches nothing on mount; it
   * only PATCHes on submit and rebases its state from the response.
   */
  initial: MeProfile;
}

export function ProfileLanguageForm({ initial }: ProfileLanguageFormProps) {
  const t = useTranslations("profile.language");
  const tCurrency = useTranslations("profile.displayCurrency");
  const router = useRouter();
  const [tenantDefaultLocale, setTenantDefaultLocale] = useState<Locale>(
    initial.tenantDefaultLocale,
  );
  const [choice, setChoice] = useState<LocaleChoice>(initial.locale ?? FOLLOW_TENANT);
  const [initialChoice, setInitialChoice] = useState<LocaleChoice>(initial.locale ?? FOLLOW_TENANT);
  const [currencyChoice, setCurrencyChoice] = useState<CurrencyChoice>(
    initial.displayCurrency ?? FOLLOW_ORG_CURRENCY,
  );
  const [initialCurrencyChoice, setInitialCurrencyChoice] = useState<CurrencyChoice>(
    initial.displayCurrency ?? FOLLOW_ORG_CURRENCY,
  );
  const [saving, setSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const isDirty = choice !== initialChoice || currencyChoice !== initialCurrencyChoice;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || !isDirty) return;

    setSaving(true);
    setErrorMessage(null);
    try {
      const next = await UserService.updateMe(createClientApiClient(), {
        locale: choice === FOLLOW_TENANT ? null : choice,
        displayCurrency: currencyChoice === FOLLOW_ORG_CURRENCY ? null : currencyChoice,
      });
      const nextChoice: LocaleChoice = next.locale ?? FOLLOW_TENANT;
      const nextCurrencyChoice: CurrencyChoice = next.displayCurrency ?? FOLLOW_ORG_CURRENCY;
      setChoice(nextChoice);
      setInitialChoice(nextChoice);
      setCurrencyChoice(nextCurrencyChoice);
      setInitialCurrencyChoice(nextCurrencyChoice);
      setTenantDefaultLocale(next.tenantDefaultLocale);
      toast.success(t("success.updated"));
      // Issue #153: re-run the server components so next-intl re-resolves
      // the locale from `/v1/users/me` and the UI re-renders in the new
      // language without a hard refresh. Without this, the user sees the
      // toast but the UI stays in the previous locale until the next
      // navigation.
      router.refresh();
    } catch (error) {
      const message = resolveApiErrorMessage(error, t("errors.save"));
      setErrorMessage(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-2xl bg-surface-container-lowest p-5 border border-border-brand sm:p-6">
      <div className="max-w-3xl">
        <h2 className="font-heading text-2xl leading-tight text-on-surface">{t("title")}</h2>
        <p className="mt-2 text-sm leading-6 text-on-surface-variant">{t("description")}</p>
      </div>

      <form className="mt-6 space-y-5" onSubmit={handleSubmit}>
        <div className="grid gap-5 md:grid-cols-2">
          <div className="space-y-2">
            <label htmlFor="profile-locale" className="text-sm font-medium text-on-surface">
              {t("fields.locale")}
            </label>
            <Select
              value={choice}
              onValueChange={(value) => setChoice(value as LocaleChoice)}
              disabled={saving}
            >
              <SelectTrigger id="profile-locale" aria-label={t("fields.locale")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {/*
                 * Endonyms — each language name is shown in its own script
                 * (e.g. "Français" is always "Français" regardless of the
                 * current app locale). The "Use organisation default ({locale})"
                 * parenthetical does the same so a user who can't read the
                 * current UI language can still recognise what they would
                 * inherit. Rationale in LOCALE_NATIVE_NAMES docblock.
                 */}
                <SelectItem value={FOLLOW_TENANT}>
                  {t("fields.followTenant", {
                    locale: LOCALE_NATIVE_NAMES[tenantDefaultLocale],
                  })}
                </SelectItem>
                {SUPPORTED_LOCALES.map((locale) => (
                  <SelectItem key={locale} value={locale}>
                    {LOCALE_NATIVE_NAMES[locale]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-on-surface-variant">
              {choice === FOLLOW_TENANT
                ? t("fields.localeHint.followsTenant")
                : t("fields.localeHint.personalOverride")}
            </p>
          </div>

          <div className="space-y-2">
            <label
              htmlFor="profile-display-currency"
              className="text-sm font-medium text-on-surface"
            >
              {tCurrency("displayCurrencyLabel")}
            </label>
            <Select
              value={currencyChoice}
              onValueChange={(value) => setCurrencyChoice(value as CurrencyChoice)}
              disabled={saving}
            >
              <SelectTrigger
                id="profile-display-currency"
                aria-label={tCurrency("displayCurrencyLabel")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={FOLLOW_ORG_CURRENCY}>
                  {tCurrency("displayCurrencyPlaceholder")}
                </SelectItem>
                {DISPLAY_CURRENCIES.map((code) => (
                  <SelectItem key={code} value={code}>
                    {code}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {errorMessage ? <p className="text-sm text-error">{errorMessage}</p> : null}

        <div className="flex items-center justify-end gap-3">
          <Button type="submit" disabled={saving || !isDirty}>
            {saving ? t("actions.saving") : t("actions.save")}
          </Button>
        </div>
      </form>
    </section>
  );
}
