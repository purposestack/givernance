"use client";

import { Building2, Check, ChevronDown } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { listMyOrganizations, type OrgMembership, switchOrg } from "@/services/OrgPickerService";

interface Props {
  /** Current JWT `org_id` — the entry highlighted as the active tenant. */
  currentOrgId: string | undefined;
}

/**
 * Topbar org switcher dropdown (issue #112 / doc 22 §6.3).
 *
 * Rendered only when the user belongs to >1 tenant. The list is fetched on
 * first open to keep the common (single-tenant) case cheap; subsequent opens
 * reuse the result until the user navigates away.
 */
export function OrgSwitcher({ currentOrgId }: Props) {
  const t = useTranslations("appShell.orgSwitcher");
  const [open, setOpen] = useState(false);
  const [memberships, setMemberships] = useState<OrgMembership[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    // Pre-fetch once so we can render <nothing> vs the dropdown without a
    // layout shift when the user clicks.
    let cancelled = false;
    setLoading(true);
    listMyOrganizations()
      .then((list) => {
        if (!cancelled) setMemberships(list);
      })
      .catch(() => {
        if (!cancelled) setMemberships([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading || !memberships) return null;
  if (memberships.length < 2) return null;

  const current = memberships.find((m) => m.orgId === currentOrgId);

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
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
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
          {memberships.map((m) => (
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
