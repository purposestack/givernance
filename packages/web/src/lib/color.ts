/**
 * Pick a readable text colour for a given hex background — used to render
 * the donor's tenant-themed CTA buttons + suggested-amount chips legibly
 * regardless of the operator's chosen `colorPrimary`.
 *
 * Returns `#FFFFFF` (white) for dark/saturated backgrounds and `#111827`
 * (near-black) for light ones. Threshold tuned empirically to match what
 * a donor would label as "readable" — formal WCAG 4.5:1 enforcement is
 * the design system's responsibility on the static palette; this is the
 * runtime fallback for the per-tenant override colour.
 */
export function getReadableTextColor(hex: string): "#FFFFFF" | "#111827" {
  const normalized = hex.replace("#", "");
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.6 ? "#111827" : "#FFFFFF";
}
