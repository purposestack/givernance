"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

type SettingsNavKey = "organization" | "members" | "funds" | "bankAccounts" | "featureFlags";

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
];

const FEATURE_FLAGS_NAV_ITEM: SettingsNavItem = {
  href: "/settings/feature-flags",
  key: "featureFlags",
  match: (pathname: string) => pathname.startsWith("/settings/feature-flags"),
};

/**
 * Settings-area nav strip.
 *
 * Phase 2 (Epic #365) adds an optional "Feature flags" entry — the
 * parent server component decides whether to surface it by reading
 * the `admin.feature_flags_phase2` flag SSR-side and passing
 * `showFeatureFlags`. We render the entry conditionally rather than
 * always-on so a non-org_admin user (or an org where the flag is
 * off) never sees a dead-end link.
 */
export function SettingsNavigation({
  showFeatureFlags = false,
}: {
  showFeatureFlags?: boolean;
} = {}) {
  const pathname = usePathname();
  const t = useTranslations("settings.navigation");

  const items = showFeatureFlags
    ? [...SETTINGS_NAV_ITEMS, FEATURE_FLAGS_NAV_ITEM]
    : SETTINGS_NAV_ITEMS;

  return (
    <nav aria-label={t("label")} className="overflow-x-auto">
      <div className="inline-flex min-w-full gap-2 rounded-2xl bg-surface-container p-2 shadow-card">
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
                  ? "bg-surface-container-lowest text-on-surface shadow-card"
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
