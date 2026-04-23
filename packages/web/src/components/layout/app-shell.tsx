"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { ImpersonationInfo } from "@/lib/auth";

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
      <Sidebar open={sidebarOpen} onClose={handleSidebarClose} membershipCount={membershipCount} />

      <div className="flex min-h-screen flex-1 flex-col md:ml-[var(--sidebar-width)]">
        <ImpersonationBanner impersonation={impersonation} userName={impersonationUserName} />
        <ProvisionalAdminBanner info={provisionalAdmin} />
        <Topbar
          onMenuToggle={handleMenuToggle}
          sidebarOpen={sidebarOpen}
          hamburgerRef={hamburgerRef}
        />

        <main
          id="main-content"
          className="w-full max-w-[var(--content-max)] flex-1 p-[var(--content-padding)]"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
