import { useLocale, useTranslations } from "next-intl";

import { formatCurrency } from "@/lib/format";
import type { ArchetypePageData } from "./types";

/**
 * Shared progress-bar derivation for every archetype's `Progress`
 * slot. Computes `hasGoal`, clamped `progressPercent`, the locale-
 * formatted amounts, and the canonical `aria-valuetext` once so each
 * archetype's slot is pure skinning (Tailwind / CSS classes around the
 * same numbers + same a11y wording).
 *
 * Returns `null` when no goal is configured — the slot should early-
 * return `null` in that branch (donor sees no counter).
 *
 * **Locale + currency** (issue #615): amounts are formatted with the
 * page locale (`useLocale()` — the slots are client components under
 * the root `NextIntlClientProvider`) and the campaign's
 * `data.defaultCurrency`. Slots never call `formatCurrency` / `Intl`
 * with a literal locale themselves; they render `raisedFormatted` /
 * `goalFormatted` and take their words from
 * `publicDonationPage.progress.*`.
 *
 * **a11y wording**: kept identical across archetypes on purpose so
 * screen-reader donors hear the same template regardless of style
 * (`publicDonationPage.progress.ariaValueText`):
 *   "<N> percent funded — <raised> of <goal>"
 */
export interface ProgressModel {
  /** `data.goalAmountCents` clamped to the non-null branch, so the
   *  caller doesn't have to re-check. */
  goalCents: number;
  /** Integer 0–100 inclusive. */
  progressPercent: number;
  /** `data.raisedCents` in the page locale + campaign currency. */
  raisedFormatted: string;
  /** `goalCents` in the page locale + campaign currency. */
  goalFormatted: string;
  /** `data.donorCount` with the page locale's digit grouping — for slots
   *  that show the bare number under a label. Sentence-style slots pass
   *  the raw count to their ICU `plural` message instead. */
  donorCountFormatted: string;
  /** Pre-formatted a11y string for `<div role="progressbar"
   *  aria-valuetext={…}>`. */
  ariaValueText: string;
}

export function useProgressModel(data: ArchetypePageData): ProgressModel | null {
  const locale = useLocale();
  const t = useTranslations("publicDonationPage.progress");

  const hasGoal = data.goalAmountCents !== null && data.goalAmountCents > 0;
  if (!hasGoal) return null;

  const goalCents = data.goalAmountCents ?? 0;
  const progressPercent =
    goalCents > 0 ? Math.min(100, Math.round((data.raisedCents / goalCents) * 100)) : 0;
  const raisedFormatted = formatCurrency(data.raisedCents, locale, data.defaultCurrency);
  const goalFormatted = formatCurrency(goalCents, locale, data.defaultCurrency);
  const ariaValueText = t("ariaValueText", {
    percent: progressPercent,
    raised: raisedFormatted,
    goal: goalFormatted,
  });

  const donorCountFormatted = new Intl.NumberFormat(locale).format(data.donorCount);

  return {
    goalCents,
    progressPercent,
    raisedFormatted,
    goalFormatted,
    donorCountFormatted,
    ariaValueText,
  };
}
