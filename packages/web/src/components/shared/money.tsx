"use client";

import { useLocale } from "next-intl";
import { useTenantBaseCurrency } from "@/lib/hooks/use-tenant-base-currency";
import { formatCurrency } from "@/lib/format";

interface MoneyProps {
  /** Amount in cents */
  cents: number;
  /**
   * ISO-4217 currency code. When omitted the tenant's base currency is used
   * (provided by `TenantProvider` in the app layout).
   */
  currency?: string;
  /** BCP-47 locale override. Falls back to the active next-intl locale. */
  locale?: string;
  className?: string;
}

/**
 * Renders a monetary amount in the correct currency and locale.
 *
 * When no `currency` prop is passed the tenant's base currency is resolved from
 * `TenantContext` — eliminating the "EUR hardcoded" bug on multi-currency tenants.
 *
 * Usage:
 *   <Money cents={12345} />                         → "123,45 €" (tenant EUR)
 *   <Money cents={9500} currency="CHF" />           → "CHF 95.00" (explicit)
 *   <Money cents={5000} currency={donation.currency} /> → donor currency
 */
export function Money({ cents, currency, locale: localeProp, className }: MoneyProps) {
  const localeFromHook = useLocale();
  const baseCurrency = useTenantBaseCurrency();

  return (
    <span className={`font-mono tabular-nums${className ? ` ${className}` : ""}`}>
      {formatCurrency(cents, localeProp ?? localeFromHook, currency ?? baseCurrency)}
    </span>
  );
}
