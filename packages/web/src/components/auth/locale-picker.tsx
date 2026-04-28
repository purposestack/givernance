"use client";

import { isSupportedLocale, LOCALE_NATIVE_NAMES, SUPPORTED_LOCALES } from "@givernance/shared/i18n";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useTransition } from "react";
import { setLocale } from "@/i18n/locale";

/**
 * Locale picker for the auth layout.
 * Sits below the auth card, above the footer, on all pre-auth pages
 * (login, signup, invite/accept, forgot-password, etc.).
 *
 * Sets the NEXT_LOCALE cookie via the setLocale() server action so the
 * /api/auth/login route can forward the preference to Keycloak via kc_locale.
 */
export function LocalePicker() {
  const locale = useLocale();
  const t = useTranslations("auth.login");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const handleLocaleChange = useCallback(
    async (e: React.ChangeEvent<HTMLSelectElement>) => {
      const next = e.target.value;
      if (!isSupportedLocale(next) || next === locale) return;
      await setLocale(next);
      startTransition(() => router.refresh());
    },
    [locale, router],
  );

  return (
    <select
      value={locale}
      onChange={handleLocaleChange}
      disabled={isPending}
      aria-label={t("languageLabel")}
      className="rounded-pill border border-neutral-200 bg-transparent px-3 py-1 text-xs font-medium text-text-muted transition-colors duration-normal ease-out hover:border-primary hover:text-text-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
    >
      {SUPPORTED_LOCALES.map((l) => (
        <option key={l} value={l}>
          {LOCALE_NATIVE_NAMES[l]}
        </option>
      ))}
    </select>
  );
}
