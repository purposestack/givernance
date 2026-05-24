// #440 — Finance dashboard shared types
//
// All components in this directory are pure presentational primitives:
// they take already-translated strings as props (i18n happens in the
// consuming page) and they NEVER call backend APIs themselves. The
// /admin/finance page (#206) fetches data and threads it through.

export type FreshBand = "ok" | "soon" | "stale";

export type Grade = "aplus" | "a" | "b" | "c" | "d";

export type DeltaDirection = "up" | "down" | "flat" | "cost";

export type StaleBannerTone = "soon" | "stale";

export type StaleActionVariant = "primary" | "ghost" | "text";

/**
 * Shared tone enum for finance-dashboard primitives (SentimentBar,
 * CurrencyDonut legend, PMFCard legend, etc.). Each tone maps to a
 * design-token-backed CSS class in the consuming component's CSS
 * module — callers pass the semantic intent, never raw colour strings.
 * This keeps the inline-style ban honest and makes the dashboard
 * white-label safe (issue #434 BLOCKING).
 */
export type FinanceTone = "primary" | "tertiary" | "secondary" | "indigo" | "danger" | "neutral";

export interface StaleAction {
  /** Already-translated button label. */
  label: string;
  /** Material Symbols Outlined glyph name (e.g. "mail", "smart_button"). */
  icon?: string;
  /** Variant: primary = filled CTA · ghost = outlined · text = link-style. */
  variant: StaleActionVariant;
  /**
   * Mandatory verbose aria-label so screen-reader users hear the full
   * intent ("Lancer une campagne email vers les 38 tenants éligibles à
   * l'enquête PMF") rather than the truncated visible label.
   */
  ariaLabel: string;
  /**
   * Invoked on click. Components do NOT call the backend — the consuming
   * page wires this to /v1/superadmin/surveys/:slug/{launch,schedule}.
   */
  onClick?: () => void;
  /**
   * Once true, the button label/copy should reflect "déjà lancé" and the
   * button becomes inert (per UX-review pending item: "banner should
   * disable buttons + swap copy on click"). The component honours the
   * disabled attribute and renders the button in muted styling.
   */
  disabled?: boolean;
}

export interface SentimentSegment {
  key: string;
  /** Percent 0-100. The component normalises to flex-grow. */
  percent: number;
  /** Semantic tone — maps to a CSS class in sentiment-bar.module.css. */
  tone: FinanceTone;
  /** Already-translated short label for the legend. */
  label: string;
}

export interface CurrencySlice {
  key: string;
  percent: number;
  /** Semantic tone — maps to a CSS class in currency-donut.module.css. */
  tone: FinanceTone;
  /** Already-translated currency label (e.g. "EUR", "GBP"). */
  label: string;
  /** Already-formatted amount (e.g. "€873 480"). */
  amount?: string;
}

export interface SparklinePoint {
  /** X coordinate within the sparkline's logical scale (any unit). */
  x: number;
  /** Y coordinate within the sparkline's logical scale (any unit). */
  y: number;
}

export interface HistogramBin {
  /** Already-translated bin label (e.g. "70-80"). */
  label: string;
  count: number;
  /** Optional CSS colour token; defaults to --color-primary. */
  color?: string;
  /** Optional sublabel (e.g. grade letter "A" beneath "70-80"). */
  sublabel?: string;
  /** Sublabel colour for grade tinting. */
  sublabelColor?: string;
}

export interface ChartPoint {
  /** Already-formatted x-axis label (e.g. "24 avr"). */
  label: string;
  volume: number;
  revenue: number;
}

export type ColumnKey = "rank" | "name" | "share" | "grade" | "amount";

export interface TenantRow {
  id: string;
  name: string;
  /** Share of total volume, 0-100. */
  sharePercent: number;
  grade: Grade;
  /** Score 0-100. */
  score: number;
  /** Already-formatted volume string (e.g. "€280 250"). */
  volume: string;
  /** Already-formatted commission string (e.g. "€5 056"). */
  commission?: string;
  /** Optional tenant detail href; defaults to "#". */
  href?: string;
}
