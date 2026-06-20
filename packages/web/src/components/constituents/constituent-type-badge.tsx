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

/**
 * Resolve the colour variant + localised label for a single raw type value.
 * Shared by the single-badge and multi-chip renderers so both stay in lockstep.
 */
function useTypeMeta() {
  const tType = useTranslations("constituents.types");
  return (type: string): { variant: BadgeVariant; label: string } => {
    // The API returns the raw enum (lowercase); normalise so a stray casing
    // (e.g. `PARTNER` from a different projection) still maps correctly.
    const normalised = type.toLowerCase();
    return {
      variant: TYPE_VARIANTS[normalised] ?? "neutral",
      label: isKnownType(normalised) ? tType(normalised) : type,
    };
  };
}

export function ConstituentTypeBadge({
  type,
  shape,
}: {
  type: string;
  /** Forwarded to `Badge` — `"square"` for dense contexts, default pill. */
  shape?: "square" | "pill";
}) {
  const typeMeta = useTypeMeta();
  const { variant, label } = typeMeta(type);
  return (
    <Badge variant={variant} shape={shape}>
      {label}
    </Badge>
  );
}

/**
 * Multi-type renderer (issue #465). Renders every type as its own colour-coded
 * chip. In tight contexts (table cells) pass `maxVisible` to collapse the tail
 * into a single neutral `+N` overflow chip whose `title` lists the hidden
 * labels — mirrors `docs/design/constituents/list.html`.
 *
 * Used only when the `constituents.multi_type` flag is on; the off-state path
 * keeps rendering the single `ConstituentTypeBadge` on `types[0]` so behaviour
 * is identical to today's single picklist.
 */
export function ConstituentTypeBadges({
  types,
  shape,
  maxVisible,
}: {
  types: readonly string[];
  /** Forwarded to `Badge` — `"square"` for dense contexts, default pill. */
  shape?: "square" | "pill";
  /** Collapse types beyond this count into a single `+N` overflow chip. */
  maxVisible?: number;
}) {
  const tType = useTranslations("constituents.types");
  const typeMeta = useTypeMeta();

  if (types.length === 0) {
    return <span className="text-on-surface-variant">—</span>;
  }

  const visible = typeof maxVisible === "number" ? types.slice(0, maxVisible) : types;
  const hidden = typeof maxVisible === "number" ? types.slice(maxVisible) : [];
  const hiddenTitle = hidden.map((t) => typeMeta(t).label).join(", ");

  return (
    <div className="flex flex-wrap items-center gap-1">
      {visible.map((type) => {
        const { variant, label } = typeMeta(type);
        return (
          <Badge key={type} variant={variant} shape={shape}>
            {label}
          </Badge>
        );
      })}
      {hidden.length > 0 ? (
        <Badge variant="neutral" shape={shape} title={hiddenTitle}>
          {tType("overflow", { count: hidden.length })}
        </Badge>
      ) : null}
    </div>
  );
}
