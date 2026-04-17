"use client";

import { useCallback, useState } from "react";

import { ImpersonationBanner } from "./impersonation-banner";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";

interface AppShellProps {
  children: React.ReactNode;
}

/**
 * App shell — combines sidebar, topbar, impersonation banner, and main content.
 * Manages mobile sidebar open/close state.
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
export function AppShell({ children }: AppShellProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const handleMenuToggle = useCallback(() => {
    setSidebarOpen((prev) => !prev);
  }, []);

  const handleSidebarClose = useCallback(() => {
    setSidebarOpen(false);
  }, []);

  return (
    <div className="flex min-h-screen">
      <Sidebar open={sidebarOpen} onClose={handleSidebarClose} />

      <div className="flex min-h-screen flex-1 flex-col md:ml-[var(--sidebar-width)]">
        <ImpersonationBanner />
        <Topbar onMenuToggle={handleMenuToggle} />

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
