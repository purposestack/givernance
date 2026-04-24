"use client";

import {
  Building2,
  ChevronsUpDown,
  Gift,
  LayoutDashboard,
  LogOut,
  RefreshCw,
  ShieldAlert,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ComponentType, SVGProps } from "react";
import { useEffect } from "react";

import { Logo } from "@/components/shared/logo";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/lib/auth";

/** Tailwind `md` breakpoint in pixels. */
const MD_BREAKPOINT = 768;

/** Navigation item definition — labelKey references appShell.sidebar.{key}. */
interface NavItem {
  href: string;
  labelKey: "dashboard" | "constituents" | "donations";
  icon: ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>;
}

interface AdminNavItem {
  href: string;
  labelKey: "tenants" | "disputes";
  icon: ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>;
}

/**
 * Navigation items — only features with implemented pages.
 * Add new entries here as pages are built (issues #41, #42, etc.).
 */
const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", labelKey: "dashboard", icon: LayoutDashboard },
  { href: "/constituents", labelKey: "constituents", icon: Users },
  { href: "/donations", labelKey: "donations", icon: Gift },
];

/**
 * Givernance-operator navigation — rendered only when the caller has the
 * `super_admin` realm role (doc 22 §6.4: "Never surface the admin nav link
 * to non-super-admins"). Non-super-admins never see the section; requesting
 * any admin URL directly yields 404 via `(admin)/layout.tsx`.
 */
const ADMIN_NAV_ITEMS: AdminNavItem[] = [
  { href: "/admin/tenants", labelKey: "tenants", icon: Building2 },
  { href: "/admin/disputes", labelKey: "disputes", icon: ShieldAlert },
];

interface SidebarProps {
  open: boolean;
  onClose: () => void;
  membershipCount?: number;
}

/**
 * Sidebar navigation — 288px fixed, collapsible on mobile.
 * Matches dashboard.html mockup layout and base.css sidebar specs.
 */
export function Sidebar({ open, onClose, membershipCount }: SidebarProps) {
  const pathname = usePathname();
  const { user, hasRole, logout } = useAuth();
  const t = useTranslations("appShell.sidebar");
  const tAdmin = useTranslations("appShell.sidebar.admin");
  const isSuperAdmin = hasRole("super_admin");
  const canSwitchOrganization = typeof membershipCount !== "number" || membershipCount > 1;

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

  function handleMobileClose() {
    if (window.innerWidth < MD_BREAKPOINT) {
      setTimeout(onClose, 100);
    }
  }

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
          <Logo className="h-10 w-10 shrink-0" />
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
                  handleMobileClose();
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

          {isSuperAdmin && (
            <section
              className="mt-6 border-t border-outline-variant pt-4"
              aria-label={tAdmin("section")}
            >
              <h2 className="mb-2 px-4 text-xs font-semibold uppercase tracking-wide text-on-surface-variant">
                {tAdmin("section")}
              </h2>
              {ADMIN_NAV_ITEMS.map((item) => {
                const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={handleMobileClose}
                    className={`flex items-center gap-4 rounded-lg px-4 py-3 text-sm transition-colors duration-normal ease-out focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ${
                      isActive
                        ? "bg-surface-container font-medium text-primary"
                        : "text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface"
                    }`}
                    aria-current={isActive ? "page" : undefined}
                  >
                    <Icon size={20} aria-hidden="true" />
                    <span>{tAdmin(item.labelKey)}</span>
                  </Link>
                );
              })}
            </section>
          )}
        </nav>

        {/* Footer — workspace switcher with org settings and user actions */}
        <div className="p-6">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors duration-normal ease-out hover:bg-surface-container-low focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
              >
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
                  <div className="truncate text-xs text-on-surface-variant">
                    {user?.orgName ?? t("orgPlaceholder")}
                  </div>
                </div>
                <ChevronsUpDown
                  size={16}
                  className="shrink-0 text-on-surface-variant"
                  aria-hidden="true"
                />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-[var(--sidebar-width)] max-w-[calc(100vw-2rem)]"
            >
              <DropdownMenuLabel>{user?.orgName ?? t("orgPlaceholder")}</DropdownMenuLabel>
              {canSwitchOrganization ? (
                <DropdownMenuItem asChild>
                  <Link href="/select-organization" onClick={handleMobileClose}>
                    <RefreshCw size={16} aria-hidden="true" />
                    <span>{t("changeOrganization")}</span>
                  </Link>
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem asChild>
                <Link href="/settings" onClick={handleMobileClose}>
                  {t("workspaceSettings")}
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{user?.email ?? t("userPlaceholder")}</DropdownMenuLabel>
              <DropdownMenuItem onSelect={logout}>
                <LogOut size={16} aria-hidden="true" />
                <span>{t("signOut")}</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>
    </>
  );
}
