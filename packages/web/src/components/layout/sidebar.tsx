"use client";

import {
  BarChart3,
  FileBarChart,
  Hand,
  Heart,
  Landmark,
  Layers,
  LayoutDashboard,
  MessageSquare,
  Settings,
  Users,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentType, SVGProps } from "react";

import { useAuth } from "@/lib/auth";

/** Navigation item definition. */
interface NavItem {
  href: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/constituents", label: "Constituants", icon: Users },
  { href: "/donations", label: "Dons & Campagnes", icon: Heart },
  { href: "/grants", label: "Subventions", icon: Landmark },
  { href: "/programs", label: "Programmes", icon: Layers },
  { href: "/volunteers", label: "Bénévoles", icon: Hand },
  { href: "/impact", label: "Impact", icon: BarChart3 },
  { href: "/communications", label: "Communications", icon: MessageSquare },
  { href: "/reports", label: "Rapports", icon: FileBarChart },
  { href: "/settings", label: "Paramètres", icon: Settings },
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
  const { user } = useAuth();

  const initials = user
    ? `${user.firstName?.[0] ?? ""}${user.lastName?.[0] ?? ""}`.toUpperCase() || "?"
    : "?";

  return (
    <>
      {/* Mobile overlay */}
      <div
        className={`fixed inset-0 z-[150] bg-overlay transition-opacity duration-slow ease-out md:hidden ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        onClick={onClose}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
        aria-hidden="true"
      />

      {/* Sidebar */}
      <aside
        className={`fixed top-0 left-0 z-[200] flex h-screen w-[var(--sidebar-width)] flex-col overflow-y-auto overflow-x-hidden bg-surface-container-high transition-transform duration-slow ease-out md:z-[var(--z-sticky)] md:translate-x-0 ${
          open ? "translate-x-0 shadow-2xl" : "-translate-x-full"
        }`}
        aria-label="Navigation principale"
      >
        {/* Brand */}
        <div className="flex items-center gap-3 p-8">
          <Image
            src="/logo-pheonix-vert.png"
            alt="Givernance"
            width={36}
            height={36}
            className="shrink-0 object-cover"
          />
          <span className="font-heading text-2xl font-medium tracking-tight text-on-surface">
            Givernance
          </span>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 py-3" aria-label="Menu principal">
          {NAV_ITEMS.map((item) => {
            const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
            const Icon = item.icon;

            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => {
                  // Close mobile sidebar on navigation
                  if (window.innerWidth < 768) {
                    setTimeout(onClose, 100);
                  }
                }}
                className={`flex items-center gap-4 rounded-lg px-4 py-3 text-sm transition-colors duration-normal ease-out ${
                  isActive
                    ? "bg-surface-container font-medium text-primary"
                    : "text-on-surface-variant hover:bg-surface-container-low hover:text-on-surface"
                }`}
                aria-current={isActive ? "page" : undefined}
              >
                <Icon size={20} aria-hidden="true" />
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        {/* Footer — org + user */}
        <div className="p-6">
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
          </div>
        </div>
      </aside>
    </>
  );
}
