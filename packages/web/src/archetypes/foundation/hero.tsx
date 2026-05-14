import Image from "next/image";
import { InitialLetterAvatar } from "@/components/branding/initial-letter-avatar";
import type { HeroSlotProps } from "../types";

/**
 * Foundation `Hero` slot — institutional headline + mission, with
 * the operator's brand-colour gradient. Mirrors the live layout in
 * `app/(public)/p/[id]/page.tsx`.
 */
export function FoundationHero({ data }: HeroSlotProps) {
  return (
    // PR-4b will move the `--brand-primary` CSS variable to the shell
    // root per ADR-030 § How the hybrid composes ("The shell sets
    // style={{ '--brand-primary': colorPrimary, … }} on the root
    // <main>"). Today the shell wiring isn't in place yet so the Hero
    // sets the var locally; Progress + Footer read `data.colorPrimary`
    // directly, so this temporary local pin doesn't leak elsewhere.
    <div
      className="overflow-hidden rounded-[32px] border border-outline-variant bg-surface-container-lowest shadow-card"
      style={
        {
          "--brand-primary": data.colorPrimary,
        } as React.CSSProperties
      }
    >
      <div
        className="px-5 py-8 sm:px-8 sm:py-10 lg:px-10 lg:py-12"
        style={{
          background: `linear-gradient(135deg, ${data.colorPrimary}, color-mix(in srgb, ${data.colorPrimary} 60%, #0B1220))`,
          color: "var(--color-on-primary, #ffffff)",
        }}
      >
        <div className="mb-6 flex">
          {data.organisationLogoUrl ? (
            <div className="relative h-14 w-14 overflow-hidden rounded-xl bg-white/10 backdrop-blur-sm">
              <Image
                src={data.organisationLogoUrl}
                alt={data.organisationName}
                fill
                sizes="56px"
                unoptimized
                className="object-contain"
                priority
              />
            </div>
          ) : (
            <InitialLetterAvatar orgName={data.organisationName} size="lg" />
          )}
        </div>
        <p className="text-xs font-medium uppercase tracking-[0.18em] opacity-80">
          {data.organisationName}
        </p>
        <h1 className="mt-4 max-w-3xl font-heading text-4xl leading-tight sm:text-5xl">
          {data.title}
        </h1>
        {data.description ? (
          <p className="mt-4 max-w-2xl text-base leading-7 opacity-90 sm:text-lg">
            {data.description}
          </p>
        ) : null}
        {data.organisationMission ? (
          <p className="mt-3 max-w-2xl text-sm italic leading-6 opacity-80">
            {data.organisationMission}
          </p>
        ) : null}
      </div>
    </div>
  );
}
