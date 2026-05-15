import type { HeroSlotProps } from "../types";

/**
 * Editorial Story `Hero` — photo band + serif display + drop-cap lede.
 * No easter egg: editorial voice keeps things contemplative.
 */
export function EditorialHero({ data }: HeroSlotProps) {
  return (
    <div className="editorial-hero">
      <div className="editorial-hero__photo" aria-hidden="true" />
      {data.organisationName ? (
        <p className="editorial-hero__eyebrow">{data.organisationName}</p>
      ) : null}
      {data.title ? <h1 className="editorial-hero__title">{data.title}</h1> : null}
      {data.description ? <p className="editorial-hero__lede">{data.description}</p> : null}
    </div>
  );
}
