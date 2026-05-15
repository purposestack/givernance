import type { HeroSlotProps } from "../types";

/**
 * Minimal Checkout `Hero` — quiet meta + tight headline. No avatar,
 * no decoration: the donor already trusts the org, no pitch needed.
 */
export function MinimalHero({ data }: HeroSlotProps) {
  return (
    <div className="minimal-hero">
      {data.organisationName ? (
        <p className="minimal-hero__eyebrow">{data.organisationName}</p>
      ) : null}
      {data.title ? <h1 className="minimal-hero__title">{data.title}</h1> : null}
      {data.description ? <p className="minimal-hero__lede">{data.description}</p> : null}
    </div>
  );
}
