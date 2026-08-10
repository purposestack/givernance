import { formatCurrency } from "@/lib/format";
import type { ArchetypePageData } from "./types";

/**
 * Shared progress-bar derivation for every archetype's `Progress`
 * slot. Computes `hasGoal`, clamped `progressPercent`, and the
 * canonical `aria-valuetext` once so each archetype's slot is pure
 * skinning (Tailwind / CSS classes around the same numbers + same
 * a11y wording).
 *
 * Returns `null` when no goal is configured — the slot should early-
 * return `null` in that branch (donor sees no counter).
 *
 * **a11y wording**: kept identical across archetypes on purpose so
 * screen-reader donors hear the same template regardless of style:
 *   "<N> percent funded — <raised> of <goal> <currency>"
 */
export interface ProgressModel {
  /** `data.goalAmountCents` clamped to the non-null branch, so the
   *  caller doesn't have to re-check. */
  goalCents: number;
  /** Integer 0–100 inclusive. */
  progressPercent: number;
  /** Pre-formatted a11y string for `<div role="progressbar"
   *  aria-valuetext={…}>`. */
  ariaValueText: string;
}

export function useProgressModel(data: ArchetypePageData): ProgressModel | null {
  const hasGoal = data.goalAmountCents !== null && data.goalAmountCents > 0;
  if (!hasGoal) return null;

  const goalCents = data.goalAmountCents ?? 0;
  const progressPercent =
    goalCents > 0 ? Math.min(100, Math.round((data.raisedCents / goalCents) * 100)) : 0;
  const ariaValueText = `${progressPercent} percent funded — ${formatCurrency(
    data.raisedCents,
    data.locale,
    data.defaultCurrency,
  )} of ${formatCurrency(goalCents, data.locale, data.defaultCurrency)}`;

  return { goalCents, progressPercent, ariaValueText };
}
