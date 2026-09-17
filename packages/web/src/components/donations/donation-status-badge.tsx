import { Check, Clock, type LucideIcon, Undo2, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { Badge, type BadgeProps } from "@/components/ui/badge";
import type { DonationStatus } from "@/models/donation";

/**
 * Colour semantics follow docs/11 + the donations mockups
 * (`docs/design/donations/list.html`): cleared = success, pending = warning,
 * failed = error; refunded is a settled-then-reversed state, not an error →
 * info. Colour is never the sole signal — every status pairs an icon with its
 * text label (ADR-012, colourblind-safe semantics).
 */
const STATUS_STYLES: Record<DonationStatus, { variant: BadgeProps["variant"]; Icon: LucideIcon }> =
  {
    cleared: { variant: "success", Icon: Check },
    pending: { variant: "warning", Icon: Clock },
    refunded: { variant: "info", Icon: Undo2 },
    failed: { variant: "error", Icon: X },
  };

/** Donation lifecycle status badge — donation detail header + donations list (issue #614). */
export function DonationStatusBadge({ status }: { status: DonationStatus }) {
  const t = useTranslations("donations.status");
  const { variant, Icon } = STATUS_STYLES[status];
  return (
    <Badge variant={variant}>
      <Icon size={12} aria-hidden="true" />
      {t(status)}
    </Badge>
  );
}
