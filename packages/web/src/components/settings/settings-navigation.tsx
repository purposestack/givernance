"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

import { useSettingsNavFlags } from "@/components/settings/settings-nav-flags";
import { cn } from "@/lib/utils";

type SettingsNavKey =
  | "organization"
  | "members"
  | "funds"
  | "bankAccounts"
  | "featureFlags"
  | "customFields";

interface SettingsNavItem {
  href: string;
  key: SettingsNavKey;
  match: (pathname: string) => boolean;
}

const SETTINGS_NAV_ITEMS: SettingsNavItem[] = [
  {
    href: "/settings",
    key: "organization",
    match: (pathname: string) => pathname === "/settings",
  },
  {
    href: "/settings/members",
    key: "members",
    match: (pathname: string) => pathname.startsWith("/settings/members"),
  },
  {
    href: "/settings/funds",
    key: "funds",
    match: (pathname: string) => pathname.startsWith("/settings/funds"),
  },
  {
    href: "/settings/bank-accounts",
    key: "bankAccounts",
    match: (pathname: string) => pathname.startsWith("/settings/bank-accounts"),
  },
  {
    href: "/settings/feature-flags",
    key: "featureFlags",
    match: (pathname: string) => pathname.startsWith("/settings/feature-flags"),
  },
  {
    href: "/settings/custom-fields",
    key: "customFields",
    match: (pathname: string) => pathname.startsWith("/settings/custom-fields"),
  },
];

/**
 * Settings-area nav strip. The "Feature flags" entry (Epic #365) points
 * at the org-admin self-service page; the settings area is org-admin
 * gated at the route level, so the entry is always surfaced here. The
 * "Custom fields" entry (Epic #539) only renders when at least one
 * `*.custom_fields` domain flag is on — resolved server-side by the
 * settings layout and provided via SettingsNavFlagsProvider.
 */
export function SettingsNavigation() {
  const pathname = usePathname();
  const t = useTranslations("settings.navigation");
  const { customFieldsEnabled } = useSettingsNavFlags();

  const items = SETTINGS_NAV_ITEMS.filter(
    (item) => item.key !== "customFields" || customFieldsEnabled,
  );

  return (
    <nav aria-label={t("label")} className="overflow-x-auto">
      <div className="inline-flex min-w-full gap-2 rounded-2xl bg-surface-container p-2 border border-border-brand">
        {items.map((item) => {
          const isActive = item.match(pathname);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "inline-flex min-h-11 flex-1 items-center justify-center rounded-xl px-4 py-2 text-sm font-medium transition-colors sm:flex-none",
                isActive
                  ? "bg-surface-container-lowest text-primary"
                  : "text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface",
              )}
            >
              {t(item.key)}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
