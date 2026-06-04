/**
 * Deterministic, hash-coloured initial-letter avatar — Epic #286.
 *
 * Used wherever an organisation needs to be visually identified before (or
 * in absence of) a custom uploaded logo: sidebar footer, settings logo card
 * empty state, org-picker rows, public donation page hero. The same `tenantId`
 * always picks the same colour from a fixed WCAG-AA palette so the visual
 * identity stays stable across sessions and surfaces.
 *
 * Slack-style 8-colour palette — every entry has been picked (or aliased to
 * an existing token) to clear WCAG-AA against `#ffffff` text. The `--color-*`
 * tokens come from `app/globals.css`; the fallbacks keep the avatar usable
 * on the public donation page where the brand-colour overrides are scoped to
 * the campaign hero only.
 */

import { cn } from "@/lib/utils";

interface InitialLetterAvatarProps {
  /** Organisation name — first character (uppercased) becomes the glyph. */
  orgName: string;
  /**
   * Stable identifier used to seed the deterministic colour hash. Same id
   * → same colour, every render. Falls back to `orgName` when the caller
   * doesn't have an id (e.g. public hero with only org metadata).
   */
  tenantId?: string;
  /**
   * Visual size — tracks the rest of the codebase's avatar sizing scale.
   * `sm` 32 / `md` 40 / `lg` 64 / `xl` 96 / `2xl` 128 px.
   */
  size?: "sm" | "md" | "lg" | "xl" | "2xl";
  /** Optional className passthrough — wraps the inline-block container. */
  className?: string;
  /**
   * Accessible label override. When omitted, the avatar is `aria-hidden`
   * (it's purely decorative when paired with the org name in adjacent text);
   * when set, it becomes a labelled `img` so screen readers announce it
   * (e.g. on the public donation page where it stands alone above the title).
   */
  ariaLabel?: string;
}

/**
 * 8-entry deterministic palette. Each `bg` clears AA against the white
 * `text-on-primary-fixed` glyph (contrast ratio ≥ 4.5). The order is
 * load-bearing — changing it would re-shuffle every existing org's
 * colour mapping. `Givernance Brand Green` first so brand-new tenants
 * (lowest hash variance) tend to land on the marquee colour.
 *
 * Every entry references a design token defined in `app/globals.css`
 * (PR #287 review, major 6 — ADR-012 forbids raw hex in components).
 * The hex fallback inside each `var(--color-*, …)` is preserved so
 * the avatar still renders sanely on the public donation page where
 * the brand-colour overrides scope the cascade tightly.
 */
const PALETTE: Array<{ bg: string; ring: string }> = [
  // 1. Brand teal (Material You primary fixed) — `#08675b` AA ratio 6.6
  { bg: "var(--color-primary, #08675b)", ring: "var(--color-primary-container, #b3f1cf)" },
  // 2. Indigo
  { bg: "var(--color-indigo, #5b4fd4)", ring: "var(--color-indigo-light, #ede9fe)" },
  // 3. Sky
  { bg: "var(--color-sky, #2e79a6)", ring: "var(--color-sky-light, #e0f2fe)" },
  // 4. Amber (using a darker shade so AA holds against white text)
  { bg: "var(--color-amber-strong, #a16207)", ring: "var(--color-amber-light, #fef3c7)" },
  // 5. Plum
  { bg: "var(--color-plum, #7c3aed)", ring: "var(--color-plum-light, #ede9fe)" },
  // 6. Teal
  { bg: "var(--color-teal, #0f766e)", ring: "var(--color-teal-light, #ccfbf1)" },
  // 7. Rose
  { bg: "var(--color-rose, #be185d)", ring: "var(--color-rose-light, #fce7f3)" },
  // 8. Slate
  { bg: "var(--color-slate, #475569)", ring: "var(--color-slate-light, #e2e8f0)" },
];

/** Tailwind size + typography mapping per `size` prop. */
const SIZE_CLASSES: Record<NonNullable<InitialLetterAvatarProps["size"]>, string> = {
  sm: "h-8 w-8 text-sm",
  md: "h-10 w-10 text-base",
  lg: "h-16 w-16 text-2xl",
  xl: "h-24 w-24 text-4xl",
  "2xl": "h-32 w-32 text-5xl",
};

/**
 * Stable string hash → palette index. Multiplicative-31 hash, well-known
 * (Java's `String.hashCode`), good distribution for short org-name keys.
 * Coerce to unsigned (`>>> 0`) so the result is always non-negative; the
 * `| 0` form per the issue spec works too but reads as a bug to a
 * casual reviewer.
 */
function pickPaletteIndex(seed: string, paletteLength: number): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % paletteLength;
}

export function InitialLetterAvatar({
  orgName,
  tenantId,
  size = "md",
  className,
  ariaLabel,
}: InitialLetterAvatarProps) {
  const trimmed = (orgName ?? "").trim();
  const initial = trimmed ? trimmed.charAt(0).toUpperCase() : "?";
  const seed = (tenantId ?? (trimmed || "?")).toString();
  const palette = PALETTE[pickPaletteIndex(seed, PALETTE.length)] ?? PALETTE[0];

  const a11y = ariaLabel
    ? { role: "img" as const, "aria-label": ariaLabel }
    : { "aria-hidden": true as const };

  return (
    <div
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-heading font-semibold tracking-tight text-white select-none",
        SIZE_CLASSES[size],
        className,
      )}
      style={{ backgroundColor: palette?.bg ?? "var(--color-primary)" }}
      {...a11y}
    >
      {initial}
    </div>
  );
}
