"use client";

import Image from "next/image";
import { InitialLetterAvatar } from "@/components/branding/initial-letter-avatar";
import type { HeroSlotProps } from "../types";

/**
 * Foundation `Hero` slot — institutional headline + mission, on the
 * operator's brand-colour panel.
 *
 * Styled with Tailwind utility classes (NOT bespoke CSS) so we never
 * depend on the archetype's lazy-loaded CSS file landing before
 * paint. Tailwind classes are JIT-compiled into the page's main CSS
 * bundle and always available. Only the brand-colour
 * (`backgroundColor`) is dynamic — everything else is reachable
 * via the design tokens that ship with the app shell.
 */
export function FoundationHero({ data }: HeroSlotProps) {
  return (
    <div className="overflow-hidden rounded-2xl border border-outline-variant bg-surface-container-lowest shadow-card sm:rounded-3xl">
      <div
        className="relative px-5 py-6 sm:px-7 sm:py-8 lg:px-10 lg:py-12"
        style={{ background: "var(--brand-primary)", color: "#ffffff" }}
      >
        {/* Subtle radial highlight for dimensional lighting on the
            solid brand panel. Pure CSS, no color-mix(). */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(circle at 85% 12%, rgba(255,255,255,0.18), transparent 45%)",
          }}
        />
        {/* One stacking-context wrapper for all text/icon content so we
            don't repeat `relative z-[1]` on every child. */}
        <div className="relative z-[1]">
          {data.organisationLogoUrl ? (
            <div className="mb-5 inline-flex h-12 w-12 overflow-hidden rounded-xl bg-white/10 backdrop-blur-sm sm:h-14 sm:w-14">
              <Image
                src={data.organisationLogoUrl}
                alt={data.organisationName || ""}
                fill
                sizes="56px"
                unoptimized
                className="object-contain"
                priority
              />
            </div>
          ) : data.organisationName ? (
            <div className="mb-5">
              <InitialLetterAvatar orgName={data.organisationName} size="lg" />
            </div>
          ) : null}
          {data.organisationName ? (
            <p
              className="text-[11px] font-medium uppercase tracking-[0.16em] sm:text-xs sm:tracking-[0.18em]"
              style={{ color: "#ffffff", opacity: 0.85 }}
            >
              {data.organisationName}
            </p>
          ) : null}
          {data.title ? (
            <h1
              className="mt-3 max-w-[24ch] text-balance font-heading text-2xl leading-tight sm:mt-4 sm:text-3xl lg:text-4xl"
              style={{ color: "#ffffff" }}
            >
              {data.title}
            </h1>
          ) : null}
          {data.description ? (
            <p
              className="mt-3 max-w-[52ch] text-sm leading-relaxed sm:mt-4 sm:text-base"
              style={{ color: "#ffffff", opacity: 0.9 }}
            >
              {data.description}
            </p>
          ) : null}
          {data.organisationMission ? (
            <p
              className="mt-3 max-w-[52ch] font-heading text-xs italic leading-relaxed sm:text-sm"
              style={{ color: "#ffffff", opacity: 0.78 }}
            >
              {data.organisationMission}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
