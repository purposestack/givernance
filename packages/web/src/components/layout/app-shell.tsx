"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { AddLogoBanner } from "@/components/branding/add-logo-banner";
import type { ImpersonationInfo } from "@/lib/auth";
import type { OrgLogo } from "@/models/branding";

import { ImpersonationBanner } from "./impersonation-banner";
import { ProvisionalAdminBanner, type ProvisionalAdminInfo } from "./provisional-admin-banner";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";

interface AppShellProps {
  children: React.ReactNode;
  /** SSR impersonation info from JWT (passed by server layout). */
  impersonation: ImpersonationInfo | undefined;
  /** Display name of the impersonated user. */
  impersonationUserName: string | undefined;
  /** SSR provisional-admin info from the `/users/me` query (doc 22 §3.1). */
  provisionalAdmin?: ProvisionalAdminInfo;
  /** Number of tenants the user belongs to — used to hide the org-switch action for solo-tenant users. */
  membershipCount?: number;
  /**
   * SSR-resolved super-admin flag — lets the sidebar's "Back office" section
   * render on the server instead of popping in after `/v1/users/me` hydrates.
   * FE-1 (PR #135 review).
   */
  isSuperAdmin?: boolean;
  /**
   * Active tenant id — used to scope the "Add your logo" banner's per-org
   * dismissal key (Epic #286). Optional: when missing (super-admin), the
   * banner skips its render path.
   */
  orgId?: string;
  /** Whether the current user can act on the "Add your logo" CTA (Epic #286). */
  canManageBranding?: boolean;
  /**
   * Server-resolved org logo (Epic #286 / PR #287 review, major 4).
   * Threaded down to `Sidebar` and `AddLogoBanner` so they don't each
   * re-fetch `/v1/branding/org-logo` on every navigation. `null` means
   * "no logo configured" (or super-admin path) — both consumers fall
   * back to their initial-letter / banner-shown affordance.
   */
  orgLogo?: OrgLogo | null;
}

/**
 * App shell — combines sidebar, topbar, impersonation banner, and main content.
 * Manages mobile sidebar open/close state with focus trap.
 *
 * Layout structure (matches base.css .app-layout):
 * ┌──────────┬────────────────────────────────┐
 * │          │  Impersonation Banner (if any)  │
 * │          ├────────────────────────────────┤
 * │ Sidebar  │  Topbar (80px, sticky)          │
 * │ (288px)  ├────────────────────────────────┤
 * │ (fixed)  │  Main Content (scrollable)      │
 * │          │                                │
 * └──────────┴────────────────────────────────┘
 */
export function AppShell({
  children,
  impersonation,
  impersonationUserName,
  provisionalAdmin,
  membershipCount,
  isSuperAdmin,
  orgId,
  canManageBranding = false,
  orgLogo = null,
}: AppShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const hamburgerRef = useRef<HTMLButtonElement>(null);

  const handleMenuToggle = useCallback(() => {
    setSidebarOpen((prev) => !prev);
  }, []);

  const handleSidebarClose = useCallback(() => {
    setSidebarOpen(false);
    // Return focus to hamburger after closing (WCAG 2.1)
    hamburgerRef.current?.focus();
  }, []);

  // Prevent scroll and tab-behind when mobile sidebar is open
  useEffect(() => {
    if (!sidebarOpen) return;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [sidebarOpen]);

  return (
    <div className="flex min-h-screen">
      <Sidebar
        open={sidebarOpen}
        onClose={handleSidebarClose}
        membershipCount={membershipCount}
        isSuperAdmin={isSuperAdmin}
        orgLogo={orgLogo}
      />

      <div className="flex min-h-screen flex-1 flex-col md:ml-[var(--sidebar-width)]">
        <ImpersonationBanner impersonation={impersonation} userName={impersonationUserName} />
        <ProvisionalAdminBanner info={provisionalAdmin} />
        <AddLogoBanner orgId={orgId} canManageBranding={canManageBranding} orgLogo={orgLogo} />
        <Topbar
          onMenuToggle={handleMenuToggle}
          sidebarOpen={sidebarOpen}
          hamburgerRef={hamburgerRef}
        />

        <main
          id="main-content"
          className="w-full max-w-[var(--content-max)] flex-1 p-[var(--content-padding)]"
        >
          <div className="space-y-6 sm:space-y-8">{children}</div>
        </main>
      </div>
    </div>
  );
}
