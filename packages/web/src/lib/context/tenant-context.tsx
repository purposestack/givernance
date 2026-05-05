"use client";

import { createContext, useContext } from "react";

interface TenantContextValue {
  /** ISO-4217 base currency of the current tenant (e.g. "EUR", "CHF"). */
  baseCurrency: string;
}

const TenantContext = createContext<TenantContextValue>({ baseCurrency: "EUR" });

export function TenantProvider({
  children,
  baseCurrency,
}: {
  children: React.ReactNode;
  baseCurrency: string;
}) {
  return <TenantContext.Provider value={{ baseCurrency }}>{children}</TenantContext.Provider>;
}

export function useTenantContext(): TenantContextValue {
  return useContext(TenantContext);
}
