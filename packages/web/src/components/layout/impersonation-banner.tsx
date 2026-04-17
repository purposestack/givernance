"use client";

import { ShieldAlert } from "lucide-react";

import { useAuth } from "@/lib/auth";

/**
 * Impersonation amber banner — shown persistently when the JWT contains
 * an RFC 8693 `act` claim (admin impersonating another user).
 *
 * Displays who is being impersonated and provides a way to end the session.
 */
export function ImpersonationBanner() {
  const { user, isImpersonating, logout } = useAuth();

  if (!isImpersonating || !user) return null;

  const displayName = `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || user.email;

  return (
    <div
      className="flex items-center justify-center gap-3 px-4 py-2 text-sm font-medium"
      style={{
        background: "rgba(134, 71, 0, 0.1)",
        color: "var(--color-on-tertiary-fixed-variant)",
        borderBottom: "1px solid var(--color-tertiary-fixed-dim)",
      }}
      role="alert"
      aria-live="polite"
    >
      <ShieldAlert size={16} aria-hidden="true" className="shrink-0" />
      <span>
        Vous naviguez en tant que <strong>{displayName}</strong>
      </span>
      <button
        type="button"
        onClick={logout}
        className="ml-2 rounded-md px-3 py-1 text-xs font-semibold transition-colors duration-normal ease-out"
        style={{
          background: "var(--color-tertiary)",
          color: "var(--color-on-tertiary)",
        }}
      >
        Terminer
      </button>
    </div>
  );
}
