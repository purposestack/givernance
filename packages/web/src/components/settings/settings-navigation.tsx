"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

const SETTINGS_NAV_ITEMS = [
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
] as const;

export function SettingsNavigation() {
  const pathname = usePathname();
  const t = useTranslations("settings.navigation");

  return (
    <nav aria-label={t("label")} className="overflow-x-auto">
      <div className="inline-flex min-w-full gap-2 rounded-2xl bg-surface-container p-2 shadow-card">
        {SETTINGS_NAV_ITEMS.map((item) => {
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
