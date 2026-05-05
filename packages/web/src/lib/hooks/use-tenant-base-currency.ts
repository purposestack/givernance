"use client";

import { useTenantContext } from "@/lib/context/tenant-context";

/**
 * Returns the ISO-4217 base currency configured for the current tenant.
 * Defaults to "EUR" when no TenantProvider is in the tree (e.g. in tests).
 *
 * Usage: const baseCurrency = useTenantBaseCurrency();
 */
export function useTenantBaseCurrency(): string {
  return useTenantContext().baseCurrency;
}
