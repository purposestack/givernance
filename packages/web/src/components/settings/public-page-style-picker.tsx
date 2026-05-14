"use client";

import {
  DEFAULT_PUBLIC_PAGE_STYLE,
  PUBLIC_PAGE_STYLE_REGISTRY,
  type PublicPageStyleKey,
} from "@givernance/shared/constants";
import { Check, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { ApiProblem } from "@/lib/api";
import { createClientApiClient } from "@/lib/api/client-browser";
import { TenantStyleDefaultService } from "@/services/TenantStyleDefaultService";

/**
 * Org-level public-page archetype picker (Epic #362, PR-3).
 *
 * Renders a grid of 10 tiles — each archetype gets a card with its
 * label, tagline, and voice quadrant. The currently-active value is
 * marked with a check icon; an explicit "Use Givernance default
 * (Foundation)" affordance clears the override and returns to the
 * inheritance state.
 *
 * Optimistic update: the tile flips immediately on click, with the
 * actual PATCH happening in the background. On failure the row
 * reverts and a toast surfaces the error. Matches the pattern in
 * `org-feature-flags-list.tsx`.
 *
 * RBAC: rendered only when the caller is `org_admin` and the
 * `donation.public_page_styles` flag is on for this tenant — both
 * checks happen server-side in `app/(app)/settings/page.tsx`. The
 * client component trusts the SSR guard.
 *
 * Off-state: the parent settings page hides this entire card when
 * the flag is off; the route returns 404 even if a stale tab POSTs
 * after the flag flips off.
 */
interface PublicPageStylePickerProps {
  /**
   * The current value of `tenants.default_public_page_style` for
   * this tenant. `null` means "inherits from Givernance default
   * (`foundation`)". Loaded server-side from `GET /v1/org/style-default`
   * so the first paint already shows the right state — no
   * client-side fetch + skeleton flash.
   */
  initialValue: PublicPageStyleKey | null;
}

export function PublicPageStylePicker({ initialValue }: PublicPageStylePickerProps) {
  const t = useTranslations("settings.publicPageStyle");
  const [value, setValue] = useState<PublicPageStyleKey | null>(initialValue);
  const [busyKey, setBusyKey] = useState<PublicPageStyleKey | "__clear__" | null>(null);
  // Stable refs keyed by archetype identifier so a successful "clear"
  // PATCH can return focus to the inherits-default tile after the
  // clear button unmounts — keyboard users were dropping to <body>
  // otherwise (PR-3 review, I3).
  const tileRefs = useRef<Map<PublicPageStyleKey, HTMLButtonElement | null>>(new Map());

  const handlePick = async (next: PublicPageStyleKey | null) => {
    if (next === value) return; // no-op: already selected
    const previous = value;
    const busyToken = next ?? "__clear__";
    setBusyKey(busyToken);
    setValue(next); // optimistic
    try {
      const result = await TenantStyleDefaultService.setDefault(createClientApiClient(), next);
      setValue(result.defaultPublicPageStyle);
      toast.success(
        next === null
          ? t("toast.cleared")
          : t("toast.changed", {
              label: PUBLIC_PAGE_STYLE_REGISTRY.find((entry) => entry.key === next)?.label ?? next,
            }),
      );
      // Clear-button case: the button just unmounted (gated by
      // !inherits). Restore focus to the inherits-default tile so
      // keyboard users don't fall through to <body>.
      if (next === null) {
        tileRefs.current.get(DEFAULT_PUBLIC_PAGE_STYLE)?.focus();
      }
    } catch (err) {
      setValue(previous); // revert
      toast.error(mapErrorToToast(err, t));
    } finally {
      setBusyKey(null);
    }
  };

  const effective = value ?? DEFAULT_PUBLIC_PAGE_STYLE;
  const inherits = value === null;

  return (
    <section
      aria-labelledby="public-page-style-heading"
      className="space-y-4 rounded-2xl border border-outline-variant bg-surface-container-lowest p-6"
    >
      <header className="space-y-1">
        <h2 id="public-page-style-heading" className="font-heading text-xl text-on-surface">
          {t("title")}
        </h2>
        <p className="max-w-prose text-sm text-on-surface-variant">{t("description")}</p>
      </header>

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Badge variant={inherits ? "neutral" : "info"}>
          {inherits ? t("status.inherits") : t("status.custom")}
        </Badge>
        <span className="text-on-surface-variant">{t("status.active")}</span>
        <span className="font-semibold text-on-surface">
          {PUBLIC_PAGE_STYLE_REGISTRY.find((entry) => entry.key === effective)?.label ?? effective}
        </span>
        {!inherits ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busyKey !== null}
            onClick={() => handlePick(null)}
          >
            {busyKey === "__clear__" ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            ) : null}
            {t("clear")}
          </Button>
        ) : null}
      </div>

      {/*
        ul + button pattern: the tiles are a navigation surface that
        triggers a write on click, not a single-selection form input
        (radiogroup would force a Tab-then-arrow-keys interaction
        users don't expect from a settings tile grid). `aria-pressed`
        on each button still gives SR users a "pressed" / "not
        pressed" signal on the active row.
      */}
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {PUBLIC_PAGE_STYLE_REGISTRY.map((entry) => {
          const isActive = entry.key === effective;
          const isBusy = busyKey === entry.key;
          const isInheritedDefault = entry.key === DEFAULT_PUBLIC_PAGE_STYLE && inherits;
          return (
            <li key={entry.key} aria-busy={isBusy}>
              <button
                type="button"
                aria-pressed={isActive}
                ref={(el) => {
                  tileRefs.current.set(entry.key, el);
                }}
                disabled={busyKey !== null}
                onClick={() => handlePick(entry.key)}
                className={[
                  "group relative flex w-full flex-col items-start gap-2 rounded-xl border p-4 text-left transition",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
                  isActive
                    ? "border-primary bg-primary/5"
                    : "border-outline-variant bg-surface hover:border-primary",
                  busyKey !== null && !isBusy ? "opacity-60" : "",
                ].join(" ")}
              >
                <span className="flex w-full items-start justify-between gap-2">
                  <span className="font-semibold text-on-surface">{entry.label}</span>
                  {isBusy ? (
                    <Loader2 className="size-4 animate-spin text-primary" aria-hidden="true" />
                  ) : isActive ? (
                    <Check className="size-4 text-primary" aria-hidden="true" />
                  ) : null}
                </span>
                <span className="text-xs uppercase tracking-wide text-on-surface-variant">
                  {t(`voice.${entry.voice}`)}
                </span>
                <span className="text-sm leading-snug text-on-surface-variant">
                  {entry.tagline}
                </span>
                {isInheritedDefault ? (
                  <span className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-on-surface-variant">
                    <span aria-hidden="true">↳</span> {t("status.inheritedDefault")}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>

      <p className="text-xs text-on-surface-variant">{t("footnote")}</p>
    </section>
  );
}

type ToastTranslator = ReturnType<typeof useTranslations<"settings.publicPageStyle">>;

/**
 * Map a PATCH-side error to an operator-readable toast key. The
 * picker should only see 401 (session expired), 404 (flag flipped
 * off mid-session — PR-2's `requireFlag` gate), or generic 5xx;
 * the field-level 400 from PR-2 lives on the *campaign-level* PUT,
 * not this route. Extracted out of `handlePick` to keep its cognitive
 * complexity inside Biome's threshold (PR-3 review).
 */
function mapErrorToToast(err: unknown, t: ToastTranslator): string {
  if (!(err instanceof ApiProblem)) return t("toast.error");
  if (err.status === 404) return t("toast.featureUnavailable");
  if (err.status === 401) return t("toast.sessionExpired");
  return err.detail ?? err.title ?? t("toast.error");
}
