"use client";

import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";

/**
 * Localised, colour-coded badge for a constituent `type` (donor, volunteer,
 * member, beneficiary, partner). Single source of truth so every surface
 * that lists constituents — the Constituents table AND the campaign
 * "Constituants liés" table — renders the type identically instead of one
 * showing a nice badge and the other a raw `PARTNER` enum.
 *
 * Unknown / future types fall back to a neutral badge with the raw value so
 * the column never collapses to empty.
 */

type BadgeVariant = "success" | "warning" | "error" | "info" | "neutral";

const TYPE_VARIANTS: Record<string, BadgeVariant> = {
  donor: "success",
  volunteer: "info",
  member: "warning",
  beneficiary: "warning",
  partner: "neutral",
};

const KNOWN_TYPES = ["donor", "volunteer", "member", "beneficiary", "partner"] as const;
type KnownType = (typeof KNOWN_TYPES)[number];

function isKnownType(value: string): value is KnownType {
  return (KNOWN_TYPES as readonly string[]).includes(value);
}

export function ConstituentTypeBadge({
  type,
  shape,
}: {
  type: string;
  /** Forwarded to `Badge` — `"square"` for dense contexts, default pill. */
  shape?: "square" | "pill";
}) {
  const tType = useTranslations("constituents.types");
  // The API returns the raw enum (lowercase); normalise so a stray casing
  // (e.g. `PARTNER` from a different projection) still maps correctly.
  const normalised = type.toLowerCase();
  const variant = TYPE_VARIANTS[normalised] ?? "neutral";
  const label = isKnownType(normalised) ? tType(normalised) : type;
  return (
    <Badge variant={variant} shape={shape}>
      {label}
    </Badge>
  );
}
