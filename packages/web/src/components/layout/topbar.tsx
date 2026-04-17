"use client";

import { Bell, Menu, Search } from "lucide-react";
import Link from "next/link";

import { useAuth } from "@/lib/auth";

interface TopbarProps {
  /** Current page title for breadcrumb display. */
  title?: string;
  /** Called when the hamburger menu button is pressed (mobile). */
  onMenuToggle: () => void;
}

/**
 * Top bar — 80px sticky, glass effect.
 * Matches dashboard.html mockup: breadcrumb left, search center, actions right.
 */
export function Topbar({ title, onMenuToggle }: TopbarProps) {
  const { user } = useAuth();

  const initials = user
    ? `${user.firstName?.[0] ?? ""}${user.lastName?.[0] ?? ""}`.toUpperCase() || "?"
    : "?";

  const displayName = user ? `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() : "";

  return (
    <header
      className="sticky top-0 z-[var(--z-sticky)] flex h-[var(--topbar-height)] items-center gap-4 border-b px-[var(--content-padding)]"
      style={{
        background: "var(--topbar-bg)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        borderColor: "var(--topbar-border)",
      }}
    >
      {/* Hamburger — visible on mobile only */}
      <button
        type="button"
        className="flex shrink-0 items-center justify-center rounded-md p-1.5 text-text transition-colors duration-normal ease-out hover:bg-surface-container-low md:hidden"
        onClick={onMenuToggle}
        aria-label="Ouvrir le menu"
      >
        <Menu size={20} aria-hidden="true" />
      </button>

      {/* Breadcrumb */}
      <div className="flex min-w-0 items-center gap-2 text-sm text-text-secondary">
        <span className="truncate font-medium text-text">{title ?? "Dashboard"}</span>
      </div>

      {/* Search bar — hidden on mobile */}
      <div className="relative mx-auto hidden max-w-[400px] flex-1 md:block">
        <Search
          size={16}
          className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-text-muted"
          aria-hidden="true"
        />
        <input
          type="text"
          className="h-10 w-full rounded-pill border-0 bg-surface-container-lowest pl-10 pr-14 text-sm text-text placeholder:text-text-muted focus:ring-2 focus:ring-primary focus:outline-none"
          placeholder="Rechercher..."
          style={{
            boxShadow: "0 0 0 1px rgba(190, 201, 193, 0.2)",
          }}
          aria-label="Rechercher"
        />
        <kbd className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 rounded-sm border border-border bg-neutral-100 px-1.5 py-px font-mono text-xs text-text-muted">
          ⌘K
        </kbd>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3">
        {/* Notifications bell */}
        <button
          type="button"
          className="relative flex h-10 w-10 items-center justify-center rounded-md text-text-secondary transition-colors duration-normal ease-out hover:bg-surface-container-low hover:text-text"
          aria-label="Notifications"
        >
          <Bell size={18} aria-hidden="true" />
          {/* Notification dot */}
          <span
            className="absolute top-2 right-2 h-2 w-2 rounded-full bg-tertiary"
            style={{
              border: "2px solid var(--color-surface-container-lowest)",
            }}
            aria-hidden="true"
          />
        </button>

        {/* User avatar */}
        <Link
          href="/settings"
          className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-xs font-semibold text-on-primary"
          title={displayName}
          aria-label={`Profil de ${displayName}`}
        >
          {initials}
        </Link>
      </div>
    </header>
  );
}
