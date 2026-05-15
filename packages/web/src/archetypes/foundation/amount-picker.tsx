import type { AmountSlotProps } from "../types";

/**
 * Foundation `AmountPicker` slot — institutional white-card chrome
 * wrapping the shared `<PublicDonationForm>`. Mirrors the chrome the
 * pre-Epic-362 hardcoded layout uses on the donor page.
 *
 * Today the form is monolithic (chip grid + Stripe Elements + 3DS
 * baked together); the slot just provides the outer surface. When
 * the form is split into archetype-owned chip-grid + shell-owned
 * checkout, this slot becomes the place Foundation's specific chip
 * grid lands — see ADR-030 § Slot Inventory for the per-archetype
 * picker variants.
 */
export function FoundationAmountPicker({ formNode }: AmountSlotProps) {
  return (
    <div className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-5 text-on-surface shadow-card sm:rounded-3xl sm:p-6">
      {formNode}
    </div>
  );
}
