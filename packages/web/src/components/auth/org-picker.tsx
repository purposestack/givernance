"use client";

import { Building2, ChevronRight, Clock, ShieldCheck, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useId, useMemo, useState } from "react";
import type { OrgMembership } from "@/services/OrgPickerService";
import { switchOrg } from "@/services/OrgPickerService";

interface Props {
  memberships: OrgMembership[];
  defaultOrgId?: string;
}

/** Org picker list — keyboard-navigable cards (issue #112 / doc 22 §6.3). */
export function OrgPickerClient({ memberships, defaultOrgId }: Props) {
  const t = useTranslations("auth.selectOrganization");
  const groupId = useId();

  const sorted = useMemo(() => {
    // Surface the cookie-defaulted org first, then most-recently-visited.
    const primary = memberships.find((m) => m.orgId === defaultOrgId);
    const rest = memberships.filter((m) => m.orgId !== defaultOrgId);
    return primary ? [primary, ...rest] : memberships;
  }, [memberships, defaultOrgId]);

  const initialSelection = sorted[0]?.orgId ?? "";
  const [selected, setSelected] = useState(initialSelection);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const handleSubmit = useCallback(async () => {
    if (!selected || submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const res = await switchOrg(selected);
      // Persist the cookie-based "last org" so a future login skips the picker
      // if the user is still solo on it. 30-day lifespan mirrors the picker UX.
      // biome-ignore lint/suspicious/noDocumentCookie: intentional non-httpOnly cookie read server-side to seed the picker default; Cookie Store API has insufficient browser support for our Scaleway target matrix (ADR-011).
      document.cookie = `gv-last-org=${encodeURIComponent(res.targetSlug)}; Path=/; Max-Age=${30 * 24 * 3600}; SameSite=Lax`;
      // Force a fresh JWT: the server blocklisted the current token, so a
      // naïve `router.push` would get rejected. Round-trip through the
      // login endpoint with a hint so Keycloak emits a token with the
      // target `org_id` claim (#114 wires Keycloak 26 Organizations).
      window.location.href = `/api/auth/login?hint=${encodeURIComponent(res.targetSlug)}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "switch_failed";
      setError(msg === "Forbidden" ? t("errors.forbidden") : t("errors.generic"));
      setSubmitting(false);
    }
  }, [selected, submitting, t]);

  return (
    <div>
      {error && (
        <div
          role="alert"
          aria-live="polite"
          className="mb-4 flex items-start gap-3 rounded-lg border border-error-border bg-error-container p-3 text-sm text-on-error-container"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="flex-1">{error}</span>
        </div>
      )}

      <fieldset aria-labelledby={`${groupId}-label`} className="space-y-2">
        <legend id={`${groupId}-label`} className="sr-only">
          {t("title")}
        </legend>
        {sorted.map((m) => (
          <label
            key={m.orgId}
            htmlFor={`${groupId}-${m.orgId}`}
            className={`flex cursor-pointer items-center gap-4 rounded-lg border p-4 transition-colors duration-normal ease-out focus-within:ring-2 focus-within:ring-primary ${
              selected === m.orgId
                ? "border-primary bg-primary-50"
                : "border-outline-variant hover:border-primary"
            }`}
          >
            <input
              id={`${groupId}-${m.orgId}`}
              type="radio"
              name={groupId}
              value={m.orgId}
              checked={selected === m.orgId}
              onChange={() => setSelected(m.orgId)}
              className="sr-only"
            />
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-container-low text-text">
              <Building2 size={18} aria-hidden="true" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium text-text">{m.name}</span>
                <span className="rounded-full bg-surface-container-lowest px-2 py-0.5 text-xs text-text-secondary">
                  {m.role}
                </span>
                {m.firstAdmin && m.provisionalUntil && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-light px-2 py-0.5 text-xs text-amber-text">
                    <ShieldCheck size={12} aria-hidden="true" /> {t("provisional")}
                  </span>
                )}
              </div>
              <div className="mt-0.5 flex items-center gap-3 text-xs text-text-muted">
                <span>{m.slug}</span>
                {m.lastVisitedAt && (
                  <span className="inline-flex items-center gap-1">
                    <Clock size={12} aria-hidden="true" />
                    {t("lastVisited", { date: new Date(m.lastVisitedAt).toLocaleDateString() })}
                  </span>
                )}
              </div>
            </div>
            <ChevronRight size={16} aria-hidden="true" className="text-text-muted" />
          </label>
        ))}
      </fieldset>

      <button
        type="button"
        onClick={handleSubmit}
        disabled={!selected || submitting}
        className="mt-6 inline-flex h-[var(--btn-height-lg)] w-full items-center justify-center gap-2 rounded-button bg-primary px-8 font-body text-base font-medium text-on-primary transition-opacity duration-normal ease-out hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60"
      >
        {submitting ? (
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-on-primary border-t-transparent" />
        ) : null}
        {t("continue")}
      </button>
    </div>
  );
}
