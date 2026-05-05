"use client";

import {
  Building2,
  ChevronsUpDown,
  Gift,
  LayoutDashboard,
  LogOut,
  Megaphone,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  UserCog,
  Users,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ComponentType, SVGProps } from "react";
import { useEffect, useState } from "react";

import { InitialLetterAvatar } from "@/components/branding/initial-letter-avatar";
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
import type { OrgLogo } from "@/models/branding";
import { BrandingService } from "@/services/BrandingService";

/** Tailwind `md` breakpoint in pixels. */
const MD_BREAKPOINT = 768;

/** Navigation item definition — labelKey references appShell.sidebar.{key}. */
interface NavItem {
  href: string;
  labelKey: "dashboard" | "constituents" | "campaigns" | "donations";
  icon: ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>;
}

interface AdminNavItem {
  href: string;
  labelKey: "tenants" | "disputes" | "impersonation" | "platformAdmins";
  icon: ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>;
}

/**
 * Navigation items — only features with implemented pages.
 * Add new entries here as pages are built (issues #41, #42, etc.).
 */
const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", labelKey: "dashboard", icon: LayoutDashboard },
  { href: "/constituents", labelKey: "constituents", icon: Users },
  { href: "/campaigns", labelKey: "campaigns", icon: Megaphone },
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
  { href: "/admin/impersonation", labelKey: "impersonation", icon: UserCog },
  { href: "/admin/platform-admins", labelKey: "platformAdmins", icon: ShieldCheck },
];

interface SidebarProps {
  open: boolean;
  onClose: () => void;
  membershipCount?: number;
  /**
   * SSR-resolved super-admin flag — when provided, the "Back office" section
   * renders on the server instead of popping in after `/v1/users/me`
   * hydrates. Falls back to `useAuth().hasRole("super_admin")` for legacy
   * callers that haven't threaded the prop yet.
   */
  isSuperAdmin?: boolean;
}

/**
 * Sidebar navigation — 288px fixed, collapsible on mobile.
 * Matches dashboard.html mockup layout and base.css sidebar specs.
 */
export function Sidebar({
  open,
  onClose,
  membershipCount,
  isSuperAdmin: isSuperAdminProp,
}: SidebarProps) {
  const pathname = usePathname();
  const { user, hasRole, hasAppRole, logout } = useAuth();
  const t = useTranslations("appShell.sidebar");
  const tAdmin = useTranslations("appShell.sidebar.admin");
  // Prefer the SSR-resolved flag; fall back to client-side role check so
  // callers that haven't threaded the prop still get the correct behaviour
  // (just with a brief post-hydration pop-in).
  const isSuperAdmin = isSuperAdminProp ?? hasRole("super_admin");
  // `/settings/*` is org_admin-only at the route level (see settings layout
  // guard). Hide the dropdown link for everyone else so they don't dead-end
  // on a 404.
  const canManageOrgSettings = hasAppRole("org_admin");
  // Super-admins live in `platform_admins` with no tenant memberships
  // (ADR-022), so "Change organisation" is meaningless noise for them.
  // Tenant users see it only when they're in more than one workspace.
  // Strict numeric check — an undefined / 0 membership count for a
  // non-super-admin is a broken state caught upstream in `(app)/layout.tsx`
  // (it throws so we can investigate); silently falling back to "show
  // the link" used to paper over that bug class.
  const canSwitchOrganization =
    !isSuperAdmin && typeof membershipCount === "number" && membershipCount > 1;

  const initials = user
    ? `${user.firstName?.[0] ?? ""}${user.lastName?.[0] ?? ""}`.toUpperCase() || "?"
    : "?";

  // Org logo (Epic #286) — fetched client-side once the AuthProvider has
  // hydrated `user`. Re-runs when `orgId` changes (org-switch flow) so the
  // sidebar swaps to the new tenant's logo without a hard refresh.
  // Super-admins (no orgId) skip the fetch.
  const [orgLogo, setOrgLogo] = useState<OrgLogo | null>(null);
  useEffect(() => {
    if (!user?.orgId) return;
    let active = true;
    (async () => {
      try {
        const logo = await BrandingService.getOrgLogo();
        if (!active) return;
        setOrgLogo(logo && logo.status === "ready" ? logo : null);
      } catch {
        // Silently fall back to the initial-letter avatar.
      }
    })();
    return () => {
      active = false;
    };
  }, [user?.orgId]);

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
              aria-labelledby="sidebar-backoffice-heading"
            >
              <h2
                id="sidebar-backoffice-heading"
                className="mb-2 px-4 text-xs font-semibold uppercase tracking-wide text-on-surface-variant"
              >
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

        {/* Org branding card (Epic #286) — sits above the workspace switcher
            so the operator's identity reads top-to-bottom: app brand → org
            brand → user. Hidden for super-admins (no `orgId`); they see the
            Givernance brand only. */}
        {user?.orgId && user?.orgName ? (
          <div className="px-6 pb-3">
            <div className="flex items-center gap-3 rounded-xl bg-surface-container-low p-3">
              {orgLogo?.variants?.sidebar ? (
                <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-surface-container">
                  <Image
                    src={orgLogo.variants.sidebar}
                    alt={user.orgName}
                    fill
                    sizes="64px"
                    className="object-contain"
                  />
                </div>
              ) : (
                <InitialLetterAvatar
                  orgName={user.orgName}
                  tenantId={user.orgId}
                  size="lg"
                  ariaLabel={user.orgName}
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-on-surface">{user.orgName}</div>
              </div>
            </div>
          </div>
        ) : null}

        {/* Footer — workspace switcher with org settings and user actions */}
        <div className="p-6">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex w-full items-center gap-3 rounded-xl border border-transparent px-3 py-3 text-left transition-colors duration-normal ease-out hover:bg-surface-container-low focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
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
              className="w-[min(var(--sidebar-width),calc(100vw-2rem))]"
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
              {canManageOrgSettings ? (
                <DropdownMenuItem asChild>
                  <Link href="/settings" onClick={handleMobileClose}>
                    {t("workspaceSettings")}
                  </Link>
                </DropdownMenuItem>
              ) : null}
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
