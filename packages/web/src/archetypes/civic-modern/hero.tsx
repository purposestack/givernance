import type { HeroSlotProps } from "../types";

/**
 * Civic Modern `Hero` — bordered white card, IBM Plex display, brand-
 * blue top rule. No easter egg — civic neutrality precludes them.
 */
export function CivicHero({ data }: HeroSlotProps) {
  return (
    <div className="civic-hero">
      {data.organisationName ? (
        <p className="civic-hero__eyebrow">{data.organisationName}</p>
      ) : null}
      {data.title ? <h1 className="civic-hero__title">{data.title}</h1> : null}
      {data.description ? <p className="civic-hero__lede">{data.description}</p> : null}
    </div>
  );
}
