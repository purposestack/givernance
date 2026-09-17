/**
 * Payment-method display labels (issue #614). `donations.payment_method` is a
 * free-text column: the manual form writes the first six values, the Stripe
 * webhook writes `stripe`, and imports / older rows carry spellings such as
 * `check` or `bank_transfer`. Known values are translated through the
 * `donations.paymentMethods` namespace; anything else passes through verbatim
 * rather than being hidden.
 */
export const KNOWN_PAYMENT_METHODS = [
  "wire",
  "bank_transfer",
  "cheque",
  "check",
  "card",
  "stripe",
  "sepa",
  "cash",
  "other",
] as const;

export type KnownPaymentMethod = (typeof KNOWN_PAYMENT_METHODS)[number];

/** A `useTranslations("donations.paymentMethods")` / `getTranslations(...)` translator. */
export type PaymentMethodTranslator = (key: KnownPaymentMethod) => string;

function isKnownPaymentMethod(value: string): value is KnownPaymentMethod {
  return (KNOWN_PAYMENT_METHODS as readonly string[]).includes(value);
}

/**
 * Localised label for a stored payment method. Returns `null` when nothing is
 * recorded so each call site keeps its own placeholder ("—" / "Not recorded").
 */
export function paymentMethodLabel(
  t: PaymentMethodTranslator,
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  return isKnownPaymentMethod(value) ? t(value) : value;
}
