"use client";

import { LayoutDashboard, LogOut, Settings, Users } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ComponentType, SVGProps } from "react";
import { useEffect } from "react";

import { useAuth } from "@/lib/auth";

/** Tailwind `md` breakpoint in pixels. */
const MD_BREAKPOINT = 768;

/** Navigation item definition — labelKey references appShell.sidebar.{key}. */
interface NavItem {
  href: string;
  labelKey: "dashboard" | "constituents" | "settings";
  icon: ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>;
}

/**
 * Navigation items — only features with implemented pages.
 * Add new entries here as pages are built (issues #41, #42, etc.).
 */
const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", labelKey: "dashboard", icon: LayoutDashboard },
  { href: "/constituents", labelKey: "constituents", icon: Users },
  { href: "/settings", labelKey: "settings", icon: Settings },
];

interface SidebarProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Sidebar navigation — 288px fixed, collapsible on mobile.
 * Matches dashboard.html mockup layout and base.css sidebar specs.
 */
export function Sidebar({ open, onClose }: SidebarProps) {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const t = useTranslations("appShell.sidebar");

  const initials = user
    ? `${user.firstName?.[0] ?? ""}${user.lastName?.[0] ?? ""}`.toUpperCase() || "?"
    : "?";

  // Close sidebar on Escape key (mobile)
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  return (
    <>
      {/* Mobile overlay */}
      <div
        className={`fixed inset-0 z-[var(--z-overlay)] bg-overlay transition-opacity duration-slow ease-out md:hidden ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Sidebar */}
      <aside
        id="sidebar-nav"
        className={`fixed top-0 left-0 z-[var(--z-modal)] flex h-screen w-[var(--sidebar-width)] flex-col overflow-y-auto overflow-x-hidden bg-surface-container-high transition-transform duration-slow ease-out md:z-[var(--z-sticky)] md:translate-x-0 ${
          open ? "translate-x-0 shadow-2xl" : "-translate-x-full"
        }`}
        aria-label={t("mainNav")}
      >
        {/* Brand */}
        <div className="flex items-center gap-3 p-8">
          <Image
            src="/logo-pheonix-vert.png"
            alt="Givernance"
            width={40}
            height={40}
            className="shrink-0 object-cover"
          />
          <span className="font-heading text-2xl font-medium tracking-tight text-on-surface">
            Givernance
          </span>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 py-3" aria-label={t("menuLabel")}>
          {NAV_ITEMS.map((item) => {
            const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
            const Icon = item.icon;

            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => {
                  if (window.innerWidth < MD_BREAKPOINT) {
                    setTimeout(onClose, 100);
                  }
                }}
                className={`flex items-center gap-4 rounded-lg px-4 py-3 text-sm transition-colors duration-normal ease-out focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ${
                  isActive
                    ? "bg-surface-container font-medium text-primary"
                    : "text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface"
                }`}
                aria-current={isActive ? "page" : undefined}
              >
                <Icon size={20} aria-hidden="true" />
                <span>{t(item.labelKey)}</span>
              </Link>
            );
          })}
        </nav>

        {/* Footer — org + user (matches dashboard.html mockup) */}
        <div className="p-6">
          <div className="mb-2 truncate text-sm font-medium text-on-surface-variant">
            {user?.orgName ?? t("orgPlaceholder")}
          </div>
          <div className="flex items-center gap-3">
            <div
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-on-primary"
              aria-hidden="true"
            >
              {initials}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-on-surface">
                {user?.firstName} {user?.lastName}
              </div>
              <div className="truncate text-xs text-on-surface-variant">{user?.email}</div>
            </div>
            <button
              type="button"
              onClick={logout}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-on-surface-variant transition-colors duration-normal ease-out hover:bg-surface-container-low hover:text-on-surface focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
              aria-label={t("signOut")}
              title={t("signOut")}
            >
              <LogOut size={16} aria-hidden="true" />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
