"use client";

import { Building2, Check, ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { listMyOrganizations, type OrgMembership, switchOrg } from "@/services/OrgPickerService";

interface Props {
  /** Current JWT `org_id` — the entry highlighted as the active tenant. */
  currentOrgId: string | undefined;
  /**
   * FE-3: parent passes in the membership count (from the server-side
   * `users/me/organizations` fetch) so single-tenant users never pay the
   * extra round-trip on topbar mount.
   */
  membershipCountHint?: number;
}

/**
 * Topbar org switcher dropdown (issue #112 / doc 22 §6.3).
 *
 * Rendered only when the user belongs to >1 tenant. The list is fetched
 * on first open of the dropdown (lazy) — single-tenant users never hit
 * the API at all.
 */
export function OrgSwitcher({ currentOrgId, membershipCountHint }: Props) {
  const t = useTranslations("appShell.orgSwitcher");
  const [open, setOpen] = useState(false);
  const [memberships, setMemberships] = useState<OrgMembership[] | null>(null);
  const [error, setError] = useState<string | undefined>();
  const containerRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  // FE-3: if the hint tells us the user is solo-tenant, render nothing and
  // never touch the network. The hint is populated server-side so it is
  // guaranteed-correct at mount time. The early-return is placed AFTER the
  // hooks above to respect React's rules-of-hooks; hooks below still run but
  // never mount any side-effects because `open` stays false.
  const hideSwitcher = typeof membershipCountHint === "number" && membershipCountHint < 2;

  const loadMemberships = useCallback(async () => {
    if (memberships !== null) return;
    try {
      const list = await listMyOrganizations();
      setMemberships(list);
    } catch {
      setMemberships([]);
    }
  }, [memberships]);

  const handleToggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      if (next) void loadMemberships();
      return next;
    });
  }, [loadMemberships]);

  // UX-4: Escape closes; outside-click closes; both return focus to toggle.
  useEffect(() => {
    if (!open) return;

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        toggleRef.current?.focus();
      }
    }

    function onClick(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  if (hideSwitcher) return null;

  const current = memberships?.find((m) => m.orgId === currentOrgId);

  async function handleSelect(orgId: string) {
    if (orgId === currentOrgId) {
      setOpen(false);
      return;
    }
    try {
      setError(undefined);
      const res = await switchOrg(orgId);
      // biome-ignore lint/suspicious/noDocumentCookie: see org-picker.tsx — same "last org" cookie, same rationale.
      document.cookie = `gv-last-org=${encodeURIComponent(res.targetSlug)}; Path=/; Max-Age=${30 * 24 * 3600}; SameSite=Lax`;
      window.location.href = `/api/auth/login?hint=${encodeURIComponent(res.targetSlug)}`;
    } catch {
      setError(t("errors.generic"));
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={toggleRef}
        type="button"
        onClick={handleToggle}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-md border border-border bg-surface-container-lowest px-3 py-1.5 text-sm text-text transition-colors duration-normal ease-out hover:bg-surface-container-low focus-visible:ring-2 focus-visible:ring-primary"
      >
        <Building2 size={14} aria-hidden="true" />
        <span className="max-w-[160px] truncate">{current?.name ?? t("placeholder")}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div
          role="listbox"
          aria-label={t("ariaLabel")}
          className="absolute right-0 z-20 mt-2 w-72 rounded-md border border-border bg-surface-container-lowest p-1 shadow-elevated"
        >
          {error && (
            <p className="px-3 py-2 text-xs text-error" role="alert">
              {error}
            </p>
          )}
          {memberships === null && (
            <p className="px-3 py-2 text-xs text-text-muted" role="status">
              {t("loading")}
            </p>
          )}
          {memberships?.map((m) => (
            <button
              key={m.orgId}
              role="option"
              aria-selected={m.orgId === currentOrgId}
              type="button"
              onClick={() => handleSelect(m.orgId)}
              className="flex w-full items-center gap-3 rounded-sm px-3 py-2 text-left text-sm text-text transition-colors duration-normal ease-out hover:bg-surface-container-low focus-visible:ring-2 focus-visible:ring-primary"
            >
              <Building2 size={14} aria-hidden="true" className="text-text-muted" />
              <span className="flex-1 truncate">{m.name}</span>
              <span className="text-xs text-text-muted">{m.role}</span>
              {m.orgId === currentOrgId && (
                <Check size={14} aria-hidden="true" className="text-primary" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
