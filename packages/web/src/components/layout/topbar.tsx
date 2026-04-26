"use client";

import { Bell, Menu, Search } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { RefObject } from "react";

import { useAuth } from "@/lib/auth";

interface TopbarProps {
  title?: string;
  onMenuToggle: () => void;
  sidebarOpen: boolean;
  hamburgerRef: RefObject<HTMLButtonElement | null>;
}

/**
 * Top bar — 80px sticky, glass effect.
 * Matches dashboard.html mockup: breadcrumb left, search center, actions right.
 */
export function Topbar({ title, onMenuToggle, sidebarOpen, hamburgerRef }: TopbarProps) {
  const { user, hasAppRole } = useAuth();
  const t = useTranslations("appShell.topbar");

  const initials = user
    ? `${user.firstName?.[0] ?? ""}${user.lastName?.[0] ?? ""}`.toUpperCase() || "?"
    : "?";

  const displayName = user ? `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() : "";
  // The avatar links to `/settings`, which is org_admin-only. For non-admins
  // render an informational (non-clickable) badge instead so they don't
  // dead-end on a 404. A dedicated profile page is out of scope here.
  const canManageOrgSettings = hasAppRole("org_admin");
  const avatarClasses =
    "flex h-9 w-9 items-center justify-center rounded-full bg-primary text-xs font-semibold text-on-primary focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2";

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

      <div className="flex min-w-0 items-center gap-2 text-sm text-text-secondary">
        <span className="truncate font-medium text-text">{title ?? t("breadcrumbDefault")}</span>
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

        {canManageOrgSettings ? (
          <Link
            href="/settings"
            className={avatarClasses}
            title={displayName}
            aria-label={t("profileOf", { name: displayName })}
          >
            {initials}
          </Link>
        ) : (
          <span
            role="img"
            className={avatarClasses}
            title={displayName}
            aria-label={t("profileOf", { name: displayName })}
          >
            {initials}
          </span>
        )}
      </div>
    </header>
  );
}
