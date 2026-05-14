import type { AmountSlotProps } from "../types";

/**
 * Foundation `AmountPicker` slot — institutional default. The
 * actual amount-picker UI + Stripe Elements lives in the shared
 * `<PublicDonationForm>` client island; the slot just renders it
 * inside the archetype's card chrome. This keeps the security-
 * sensitive donation flow in one place (ADR-030 § Why not full
 * per-archetype pages).
 *
 * Archetype-specific picker variants (Activist's 4-chip grid,
 * Emergency Appeal's one-time-first ordering, Calm Wellness's pill
 * chips) get their own `AmountPicker` slot implementations as they
 * land — see ADR-030 § Slot Inventory for the per-archetype mapping.
 */
export function FoundationAmountPicker({ renderForm }: AmountSlotProps) {
  return <>{renderForm()}</>;
}
