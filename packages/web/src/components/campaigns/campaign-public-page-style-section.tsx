"use client";

import {
  DEFAULT_PUBLIC_PAGE_STYLE,
  PUBLIC_PAGE_STYLE_REGISTRY,
  type PublicPageStyleKey,
} from "@givernance/shared/constants";
import { Check } from "lucide-react";

import { IMPLEMENTED_ARCHETYPE_KEYS } from "@/archetypes/registry";

/**
 * Campaign-scoped donation-page style picker (Epic #362, PR-6).
 *
 * Renders the 10-tile archetype grid. The live preview lives in the
 * existing side-rail `<CampaignPublicPagePreview>` — picking a tile
 * here updates the form state, the preview re-renders the actual
 * archetype against the current form values (title / colour / goal),
 * and the operator sees the result without leaving the editor.
 *
 * The picker is a controlled-input pair: the outer form
 * (`campaign-public-page-form.tsx`) holds the selected key in its
 * react-hook-form state and PUTs it alongside the title / description
 * / goal / color on submit. No autosave — picking a tile is local
 * state until the operator hits Save.
 *
 * Un-implemented archetypes (anything not in `IMPLEMENTED_ARCHETYPE_KEYS`)
 * render with a "Coming soon" badge so the operator knows their pick
 * will currently render as Foundation. This is the PR-4-review fix
 * for the silent-downgrade foot-gun.
 *
 * RBAC: the editor page itself is `org_admin`-gated. The flag check
 * (`donation.public_page_styles` enabled for this tenant) happens
 * server-side before this component mounts — the picker trusts the
 * SSR guard.
 *
 * Off-state: the parent editor doesn't render this section when the
 * flag is off. The route's PUT endpoint still rejects a `publicPageStyle`
 * field with a 400 in that case (PR-2's field-level flag gate).
 */
interface CampaignPublicPageStyleSectionProps {
  /**
   * Currently-selected key in the form's local state. Reflects the
   * operator's in-progress choice, NOT the persisted value (the form
   * commits on save). `null` = "no style picked — donor sees
   * Foundation."
   */
  value: PublicPageStyleKey | null;
  onChange: (next: PublicPageStyleKey | null) => void;
  /** Optional copy strings — defaulted but i18n-friendly. */
  labels?: {
    title?: string;
    description?: string;
    clear?: string;
    inheritsBadge?: string;
    comingSoonBadge?: string;
    voice?: Record<string, string>;
  };
}

export function CampaignPublicPageStyleSection({
  value,
  onChange,
  labels,
}: CampaignPublicPageStyleSectionProps) {
  const effective = value ?? DEFAULT_PUBLIC_PAGE_STYLE;

  return (
    <section
      aria-labelledby="campaign-style-heading"
      className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-5 sm:p-6"
    >
      <header className="space-y-1">
        <h2 id="campaign-style-heading" className="font-heading text-lg text-on-surface">
          {labels?.title ?? "Donation page style"}
        </h2>
        <p className="max-w-prose text-sm text-on-surface-variant">
          {labels?.description ??
            "Pick the visual archetype donors see on this campaign's public page. Your brand colour and logo stay intact — only the structure, typography, and motion change."}
        </p>
      </header>

      {value !== null ? (
        <div className="mt-4">
          <button
            type="button"
            onClick={() => onChange(null)}
            className="text-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
          >
            ↩ {labels?.clear ?? "Clear selection (donor sees Foundation)"}
          </button>
        </div>
      ) : null}

      <ul className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {PUBLIC_PAGE_STYLE_REGISTRY.map((entry) => {
          const isActive = entry.key === effective;
          const isImplemented = IMPLEMENTED_ARCHETYPE_KEYS.has(entry.key);
          const isInheritedDefault = entry.key === DEFAULT_PUBLIC_PAGE_STYLE && value === null;
          return (
            <li key={entry.key}>
              <button
                type="button"
                aria-pressed={isActive}
                onClick={() => onChange(entry.key)}
                className={[
                  "group relative flex w-full flex-col items-start gap-2 rounded-xl border p-4 text-left transition",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
                  isActive
                    ? "border-primary bg-primary/5"
                    : "border-outline-variant bg-surface hover:border-primary",
                ].join(" ")}
              >
                <span className="flex w-full items-start justify-between gap-2">
                  <span className="font-semibold text-on-surface">{entry.label}</span>
                  {isActive ? <Check className="size-4 text-primary" aria-hidden="true" /> : null}
                </span>
                <span className="text-xs uppercase tracking-wide text-on-surface-variant">
                  {labels?.voice?.[entry.voice] ?? entry.voice}
                </span>
                <span className="text-sm leading-snug text-on-surface-variant">
                  {entry.tagline}
                </span>
                <span className="mt-1 inline-flex flex-wrap gap-1.5">
                  {isInheritedDefault ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-surface-container px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-on-surface-variant">
                      <span aria-hidden="true">↳</span> {labels?.inheritsBadge ?? "Donor default"}
                    </span>
                  ) : null}
                  {!isImplemented ? (
                    <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-900">
                      {labels?.comingSoonBadge ?? "Coming soon"}
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
