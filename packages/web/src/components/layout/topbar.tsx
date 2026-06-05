"use client";

import { LOCALE_NATIVE_NAMES, type Locale, SUPPORTED_LOCALES } from "@givernance/shared/i18n";
import { Check, LogOut, Menu, Search, User } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { type RefObject, useCallback, useTransition } from "react";

import { NotificationsBell } from "@/components/notifications/notifications-bell";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { setLocale } from "@/i18n/locale";
import { createClientApiClient } from "@/lib/api/client-browser";
import { useAuth } from "@/lib/auth";
import { UserService } from "@/services/UserService";

interface TopbarProps {
  title?: string;
  onMenuToggle: () => void;
  sidebarOpen: boolean;
  hamburgerRef: RefObject<HTMLButtonElement | null>;
  /**
   * Whether to render the notifications bell (Epic #363). True for
   * tenant users, false for super-admins (no tenant-scoped events).
   * Resolved by `AppShell` from the super-admin flag.
   */
  notificationsEnabled?: boolean;
  /**
   * Whether to render the Cmd+K command-palette trigger (Epic #364).
   * True for tenant users, false for super-admins (nothing tenant-
   * scoped to search). Resolved by `AppShell` from the super-admin flag.
   */
  commandPaletteEnabled?: boolean;
  /**
   * Open the global command palette overlay (owned by AppShell).
   * Required when `commandPaletteEnabled=true`.
   */
  onCommandPaletteOpen?: () => void;
}

const avatarTriggerClasses =
  "flex h-9 w-9 items-center justify-center rounded-full bg-primary text-xs font-semibold text-on-primary outline-none transition-shadow duration-normal ease-out hover:shadow-[0_0_0_4px_rgba(8,103,91,0.10)] data-[state=open]:shadow-[0_0_0_4px_rgba(8,103,91,0.15)] focus-visible:shadow-ring";

export function Topbar({
  title,
  onMenuToggle,
  sidebarOpen,
  hamburgerRef,
  notificationsEnabled = false,
  commandPaletteEnabled = false,
  onCommandPaletteOpen,
}: TopbarProps) {
  const { user, logout } = useAuth();
  const t = useTranslations("appShell.topbar");
  const tMenu = useTranslations("appShell.topbar.accountMenu");
  const tPalette = useTranslations("appShell.commandPalette");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const [isLocalePending, startLocaleTransition] = useTransition();

  // Fallback order: first+last initials → first initial only → email first
  // char → "?" so the avatar is never blank or misleadingly generic.
  const initials = user
    ? `${user.firstName?.[0] ?? ""}${user.lastName?.[0] ?? ""}`.toUpperCase() ||
      user.email?.[0]?.toUpperCase() ||
      "?"
    : "?";

  const displayName = user ? `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() : "";
  const email = user?.email ?? "";

  // PR #360 review (Frontend i11): fall back to email when the user has
  // no name on file, so the SR announcement never reads "Account menu, "
  // with a trailing comma and nothing after it.
  const triggerLabel = displayName
    ? tMenu("triggerLabel", { name: displayName })
    : email
      ? tMenu("triggerLabel", { name: email })
      : tMenu("triggerLabelAnonymous");

  const handleLocaleSelect = useCallback(
    (next: string) => {
      if (!isLocale(next) || next === locale) return;
      void (async () => {
        // PATCH the server-side personal override first — the i18n
        // resolver on authenticated routes reads `users.locale` from
        // `/v1/users/me` and ignores the NEXT_LOCALE cookie when a
        // session exists (see `packages/web/src/i18n/request.ts`
        // → `resolveSessionLocale`). Setting the cookie alone has no
        // effect once authenticated.
        try {
          await UserService.updateMe(createClientApiClient(), { locale: next });
        } catch {
          // Network blip / API down — leave the UI on the current
          // locale; user will see they're still on the old one and
          // can retry. We deliberately do NOT toast here to keep the
          // dropdown surface quiet for a transient failure.
          return;
        }
        // Mirror the choice into NEXT_LOCALE so the next pre-auth
        // page (e.g. after sign-out) lands in the right language
        // without requiring a server round-trip.
        await setLocale(next);
        startLocaleTransition(() => router.refresh());
      })();
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
        <div className="flex items-center rounded-md bg-primary-fixed/30 px-3 py-1 text-on-primary-fixed-variant border border-primary-fixed/50">
          <span className="truncate font-medium">{title ?? t("breadcrumbDefault")}</span>
        </div>
      </div>

      {/*
        Cmd+K trigger button (Epic #364, GLO-001). Rendered for tenant
        users only (super-admins have nothing tenant-scoped to search).
        Opens the command palette via the AppShell-owned state. Visual
        mimics the mockup's input look (pill, search icon left, ⌘K badge
        right) but it's a button so pointer + keyboard activation both go
        through one path.
      */}
      {commandPaletteEnabled && onCommandPaletteOpen ? (
        <button
          type="button"
          onClick={onCommandPaletteOpen}
          aria-label={tPalette("openTrigger")}
          aria-haspopup="dialog"
          className="relative mx-auto hidden h-10 max-w-[400px] flex-1 cursor-text items-center gap-2 rounded-pill border border-border-brand bg-surface-container-lowest pl-3.5 pr-2.5 text-left text-sm text-text-muted hover:text-text focus-visible:outline-none focus-visible:border-primary focus-visible:shadow-ring md:flex"
        >
          <Search size={16} aria-hidden="true" />
          <span className="flex-1 truncate">{tPalette("placeholder")}</span>
          <kbd className="rounded-sm border border-border bg-surface-container-low px-1.5 py-px font-mono text-xs text-text-muted">
            {tPalette("shortcutBadge")}
          </kbd>
        </button>
      ) : null}

      <div className="ml-auto flex items-center gap-3">
        {/*
          NotificationsBell renders for tenant users only (Epic #363);
          super-admins receive no tenant-scoped events.
        */}
        {notificationsEnabled ? <NotificationsBell /> : null}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className={avatarTriggerClasses} aria-label={triggerLabel}>
              <span aria-hidden="true">{initials}</span>
            </button>
          </DropdownMenuTrigger>
          {/*
            sideOffset=12 — mockup spec calls for ~20px between avatar bottom
            and menu top; the primitive's default 8 was visually tight (Frontend m8).
          */}
          <DropdownMenuContent align="end" sideOffset={12} className="w-72">
            <DropdownMenuLabel className="font-normal normal-case tracking-normal">
              <div className="flex items-center gap-3 py-1">
                <div
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-on-primary"
                  aria-hidden="true"
                >
                  {initials}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold text-on-surface">
                    {displayName || email}
                  </div>
                  {displayName ? (
                    <div className="truncate text-xs text-on-surface-variant">{email}</div>
                  ) : null}
                </div>
              </div>
            </DropdownMenuLabel>

            <DropdownMenuSeparator />

            <DropdownMenuItem asChild>
              <Link href="/profile">
                <User size={16} aria-hidden="true" />
                <span>{tMenu("myAccount")}</span>
              </Link>
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            <DropdownMenuLabel>{tMenu("language")}</DropdownMenuLabel>
            {/*
              PR #360 review (Frontend M1): RadioGroup + RadioItem so Radix
              applies role="menuitemradio" + aria-checked. Earlier
              implementation used plain DropdownMenuItem + aria-current,
              which is the wrong ARIA pattern for a radio group (aria-current
              is for the active item in a *navigational* set, not an option
              in a chooser). Visible Check icon retained for sighted users.
            */}
            <DropdownMenuRadioGroup value={locale} onValueChange={handleLocaleSelect}>
              {SUPPORTED_LOCALES.map((next) => {
                const isActive = next === locale;
                const label = LOCALE_NATIVE_NAMES[next];
                return (
                  <DropdownMenuRadioItem
                    key={next}
                    value={next}
                    // Only the NON-active items go disabled while a switch
                    // is in flight — disabling the active row would make
                    // the menu look broken to a keyboard user mid-transition.
                    disabled={isLocalePending && !isActive}
                    className={isActive ? "font-semibold text-primary" : undefined}
                  >
                    <span className="flex h-5 w-7 items-center justify-center rounded-sm bg-surface-container font-mono text-[10px] font-semibold uppercase text-on-surface-variant">
                      {next}
                    </span>
                    <span>{label}</span>
                    {isActive ? (
                      <Check size={14} className="ml-auto text-primary" aria-hidden="true" />
                    ) : null}
                  </DropdownMenuRadioItem>
                );
              })}
            </DropdownMenuRadioGroup>

            <DropdownMenuSeparator />

            {/*
              PR #360 review (Frontend M2): destructive cue uses color +
              icon + explicit aria-label so it doesn't depend on color
              alone (WCAG 1.4.1 Level A).
            */}
            <DropdownMenuItem
              onSelect={logout}
              aria-label={tMenu("signOutAriaLabel")}
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

function isLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}
