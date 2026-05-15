"use client";

import { useTranslations } from "next-intl";
import type { HeroSlotProps } from "../types";

/**
 * Emergency Appeal `Hero` — warning banner above, urgent eyebrow,
 * Inter-extra-bold title. No easter egg: the appeal context is too
 * serious for delight moments.
 */
export function EmergencyHero({ data }: HeroSlotProps) {
  const t = useTranslations("publicDonationPage");
  return (
    <div className="emergency-hero">
      <div className="emergency-hero__banner">⚠ {t("badge")}</div>
      {data.organisationName ? (
        <p className="emergency-hero__eyebrow">{`// ${data.organisationName}`}</p>
      ) : null}
      {data.title ? <h1 className="emergency-hero__title">{data.title}</h1> : null}
      {data.description ? <p className="emergency-hero__lede">{data.description}</p> : null}
    </div>
  );
}
