import type { AmountSlotProps } from "../types";

/**
 * Foundation `AmountPicker` slot — institutional default.
 *
 * **Temporary degenerate state** (PR-4 review): the existing
 * `<PublicDonationForm>` client island bundles the chip-grid UI AND
 * the Stripe Elements + 3DS + idempotency-key handling in one
 * component. The slot contract's intent (per `types.ts` →
 * `AmountSlotProps`) is for the archetype to own the **picker UI**
 * (chip grid layout, recurring-first vs one-time-first ordering,
 * write-in placement, impact labels), with the shell injecting only
 * the donor fields + Stripe Elements via `renderForm()`.
 *
 * That split lands in **PR-4b** as a separate refactor of
 * `<PublicDonationForm>` into `<DonationFormChipGrid>` (archetype-
 * owned) + `<DonationFormCheckout>` (shell-owned, Stripe-bearing).
 * Until then, this slot is degenerate — it renders the entire
 * pre-split form. Foundation's chip grid (€25 / €50 / €100 / €250 /
 * €500 / €1 000 with impact labels) lives in the HTML mockup
 * `docs/design/donations/public-foundation.html` lines 551–577 and
 * will move to a `chip-grid.tsx` sibling once the split lands.
 *
 * Archetype-specific picker variants (Activist's 4-chip recurring-
 * first grid, Emergency Appeal's one-time-first ordering, Calm
 * Wellness's pill chips) will land in PR-4b–d alongside the split.
 * See ADR-030 § Slot Inventory for the full per-archetype mapping.
 */
export function FoundationAmountPicker({ renderForm }: AmountSlotProps) {
  return <>{renderForm()}</>;
}
