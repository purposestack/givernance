"use client";

import { createContext, useContext } from "react";

/**
 * Flag-derived visibility of settings-nav entries (Epic #539). The settings
 * layout (RSC) resolves the flags server-side and provides them here so the
 * client `SettingsNavigation` strip can hide flag-gated entries on every
 * settings page without each page re-fetching. Default is everything hidden
 * — the safest posture when no provider is mounted (off-state QA: a
 * disabled feature leaves no nav trace).
 */
interface SettingsNavFlags {
  /** True when at least one of the three `*.custom_fields` domain flags is on. */
  customFieldsEnabled: boolean;
}

const SettingsNavFlagsContext = createContext<SettingsNavFlags>({ customFieldsEnabled: false });

export function SettingsNavFlagsProvider({
  customFieldsEnabled,
  children,
}: SettingsNavFlags & { children: React.ReactNode }) {
  return (
    <SettingsNavFlagsContext.Provider value={{ customFieldsEnabled }}>
      {children}
    </SettingsNavFlagsContext.Provider>
  );
}

export function useSettingsNavFlags(): SettingsNavFlags {
  return useContext(SettingsNavFlagsContext);
}
