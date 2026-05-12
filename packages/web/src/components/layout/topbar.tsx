"use client";

import { LOCALE_NATIVE_NAMES, type Locale, SUPPORTED_LOCALES } from "@givernance/shared/i18n";
import { Bell, Check, LogOut, Menu, Search, User } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { type RefObject, useCallback, useTransition } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { setLocale } from "@/i18n/locale";
import { useAuth } from "@/lib/auth";

interface TopbarProps {
  title?: string;
  onMenuToggle: () => void;
  sidebarOpen: boolean;
  hamburgerRef: RefObject<HTMLButtonElement | null>;
}

const avatarTriggerClasses =
  "flex h-9 w-9 items-center justify-center rounded-full bg-primary text-xs font-semibold text-on-primary outline-none transition-shadow duration-normal ease-out hover:shadow-[0_0_0_4px_rgba(9,100,71,0.10)] data-[state=open]:shadow-[0_0_0_4px_rgba(9,100,71,0.15)] focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2";

export function Topbar({ title, onMenuToggle, sidebarOpen, hamburgerRef }: TopbarProps) {
  const { user, logout } = useAuth();
  const t = useTranslations("appShell.topbar");
  const tMenu = useTranslations("appShell.topbar.accountMenu");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const [isLocalePending, startLocaleTransition] = useTransition();

  const initials = user
    ? `${user.firstName?.[0] ?? ""}${user.lastName?.[0] ?? ""}`.toUpperCase() || "?"
    : "?";

  const displayName = user ? `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() : "";
  const email = user?.email ?? "";

  const handleLocaleSelect = useCallback(
    async (next: Locale) => {
      if (next === locale) return;
      await setLocale(next);
      startLocaleTransition(() => router.refresh());
    },
    [locale, router],
  );

  return (
    <header className="sticky top-0 z-[var(--z-sticky)] flex h-[var(--topbar-height)] items-center gap-4 border-b border-[var(--topbar-border)] bg-[var(--topbar-bg)] px-[var(--content-padding)] backdrop-blur-xl">
      <button
        ref={hamburgerRef}
        type="button"
        className="flex shrink-0 items-center justify-center rounded-md p-1.5 text-text transition-colors duration-normal ease-out hover:bg-surface-container-low focus-visible:ring-2 focus-visible:ring-primary md:hidden"
        onClick={onMenuToggle}
        aria-label={sidebarOpen ? t("closeMenu") : t("openMenu")}
        aria-expanded={sidebarOpen}
        aria-controls="sidebar-nav"
      >
        <Menu size={20} aria-hidden="true" />
      </button>

      <div className="flex min-w-0 items-center gap-2 text-sm">
        <div className="flex items-center rounded-full bg-primary-fixed/30 px-3 py-1 text-on-primary-fixed-variant shadow-sm border border-primary-fixed/50">
          <span className="truncate font-medium">{title ?? t("breadcrumbDefault")}</span>
        </div>
      </div>

      <div className="relative mx-auto hidden max-w-[400px] flex-1 md:block">
        <Search
          size={16}
          className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-text-muted"
          aria-hidden="true"
        />
        <input
          type="text"
          className="h-10 w-full rounded-pill border border-[var(--color-border-light)] bg-surface-container-lowest pl-10 pr-14 text-sm text-text placeholder:text-text-muted focus:ring-2 focus:ring-primary focus:outline-none"
          placeholder={t("searchPlaceholder")}
          aria-label={t("searchLabel")}
        />
        <kbd className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 rounded-sm border border-border bg-surface-container-low px-1.5 py-px font-mono text-xs text-text-muted">
          ⌘K
        </kbd>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          className="relative flex h-10 w-10 items-center justify-center rounded-md text-text-secondary transition-colors duration-normal ease-out hover:bg-surface-container-low hover:text-text focus-visible:ring-2 focus-visible:ring-primary"
          aria-label={t("notifications")}
        >
          <Bell size={18} aria-hidden="true" />
          <span
            className="absolute top-2 right-2 h-2 w-2 rounded-full border-2 border-surface-container-lowest bg-tertiary"
            aria-hidden="true"
          />
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={avatarTriggerClasses}
              aria-label={tMenu("triggerLabel", { name: displayName })}
            >
              <span aria-hidden="true">{initials}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72">
            <div className="flex items-center gap-3 px-3 py-2">
              <div
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-on-primary"
                aria-hidden="true"
              >
                {initials}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-on-surface">{displayName}</div>
                <div className="truncate text-xs text-on-surface-variant">{email}</div>
              </div>
            </div>

            <DropdownMenuSeparator />

            <DropdownMenuItem asChild>
              <Link href="/profile">
                <User size={16} aria-hidden="true" />
                <span>{tMenu("myAccount")}</span>
              </Link>
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            <DropdownMenuLabel>{tMenu("language")}</DropdownMenuLabel>
            {SUPPORTED_LOCALES.map((next) => {
              const isActive = next === locale;
              const label = LOCALE_NATIVE_NAMES[next];
              return (
                <DropdownMenuItem
                  key={next}
                  // Radix' onSelect fires for both pointer + keyboard activation
                  // and closes the menu by default — exactly what we want here.
                  onSelect={(event) => {
                    if (isActive || isLocalePending) {
                      event.preventDefault();
                      return;
                    }
                    void handleLocaleSelect(next);
                  }}
                  aria-current={isActive ? "true" : undefined}
                  aria-disabled={isLocalePending}
                  className={isActive ? "font-semibold text-primary" : undefined}
                >
                  <span className="flex h-5 w-7 items-center justify-center rounded-sm bg-surface-container font-mono text-[10px] font-semibold uppercase text-on-surface-variant">
                    {next}
                  </span>
                  <span>{label}</span>
                  {isActive ? (
                    <Check size={14} className="ml-auto text-primary" aria-hidden="true" />
                  ) : null}
                </DropdownMenuItem>
              );
            })}

            <DropdownMenuSeparator />

            <DropdownMenuItem
              onSelect={logout}
              className="text-error focus:bg-error-container focus:text-error"
            >
              <LogOut size={16} aria-hidden="true" />
              <span>{tMenu("signOut")}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
