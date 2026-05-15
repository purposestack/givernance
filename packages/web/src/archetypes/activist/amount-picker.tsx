import type { AmountSlotProps } from "../types";

/**
 * Activist `AmountPicker` — recurring-first per the teardown brief.
 * Wraps the shared `<PublicDonationForm>` in the Activist's high-
 * contrast card chrome. The chip-grid split into Activist-specific
 * recurring-first layout lands in the same PR-4b refactor that
 * splits `<PublicDonationForm>` (see Foundation's
 * `amount-picker.tsx` for the full rationale).
 */
export function ActivistAmountPicker({ formNode }: AmountSlotProps) {
  return (
    <div className="activist-form-wrap">
      <div className="activist-form">
        <p className="activist-form__eyebrow">★ STAND WITH US · MONTHLY</p>
        {formNode}
      </div>
    </div>
  );
}
