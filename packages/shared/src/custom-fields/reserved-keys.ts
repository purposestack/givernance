/**
 * Reserved custom-field keys (Epic #539).
 *
 * A definition key is rejected at creation when it collides with
 * anything the platform already means something by:
 *
 *   1. Core column names of the three value-bearing domains
 *      (constituents / donations / campaigns) — both snake_case and
 *      the collapsed lowercase-camel form, since the key charset
 *      (`^[a-z][a-z0-9_]{1,62}$`) admits both spellings.
 *   2. Advanced-filter DSL vocabulary (docs/30 / ADR-033): namespace
 *      segments and field names — the filter engine addresses custom
 *      fields as `custom.<key>`, so a key shadowing a DSL token would
 *      make catalogs and error messages ambiguous.
 *   3. Bulk-import header aliases (docs/28): the import template maps
 *      custom columns via `cf_<key>` headers, but bare aliases like
 *      `prenom` or `zip` must stay resolvable to core columns.
 *   4. The `cf_` and `custom` prefixes themselves (import aliasing and
 *      the JSONB column / DSL namespace).
 *
 * Keys are checked lowercase; the key pattern forbids uppercase anyway.
 * Growing this set is safe (it only blocks NEW definitions); shrinking
 * it requires auditing every consumer listed above.
 */

export const RESERVED_KEY_PREFIXES = ["cf_", "custom"] as const;

export const RESERVED_KEYS: ReadonlySet<string> = new Set([
  // ── Shared core columns ──
  "id",
  "org_id",
  "orgid",
  "created_at",
  "createdat",
  "updated_at",
  "updatedat",
  "deleted_at",
  "deletedat",
  "archived_at",
  "archivedat",
  "created_by",
  "createdby",
  "name",
  "description",
  "status",
  "type",
  "types",
  "tags",
  // ── Constituent columns + import aliases ──
  "first_name",
  "firstname",
  "prenom",
  "last_name",
  "lastname",
  "surname",
  "nom",
  "email",
  "mail",
  "courriel",
  "phone",
  "telephone",
  "tel",
  "mobile",
  "address",
  "adresse",
  "address1",
  "address2",
  "address_line1",
  "address_line_1",
  "addressline1",
  "address_line2",
  "address_line_2",
  "addressline2",
  "postal_code",
  "postalcode",
  "zip",
  "zipcode",
  "cp",
  "city",
  "ville",
  "town",
  "country",
  "pays",
  "country_code",
  "countrycode",
  "labels",
  // ── Donation columns ──
  "constituent_id",
  "constituentid",
  "amount",
  "amount_cents",
  "amountcents",
  "amount_base_cents",
  "amountbasecents",
  "currency",
  "exchange_rate",
  "exchangerate",
  "campaign_id",
  "campaignid",
  "qr_code_id",
  "swiss_qr_reference_id",
  "camt_credit_entry_id",
  "payment_source",
  "paymentsource",
  "payment_method",
  "paymentmethod",
  "payment_ref",
  "paymentref",
  "platform_fee_cents",
  "platform_fee_base_cents",
  "stripe_fee_cents",
  "refunded_at",
  "refundedat",
  "donated_at",
  "donatedat",
  "fiscal_year",
  "fiscalyear",
  "receipt_number",
  "receiptnumber",
  "receipt_amount",
  "receiptamount",
  // ── Campaign columns ──
  "parent_id",
  "parentid",
  "default_currency",
  "defaultcurrency",
  "bank_account_id",
  "bankaccountid",
  "qr_reference_mode",
  "public_page_style",
  "publicpagestyle",
  "operational_cost_cents",
  "platform_fees_cents",
  // ── Filter DSL namespaces + field names (docs/30) ──
  "constituent",
  "constituents",
  "donation",
  "donations",
  "campaign",
  "campaigns",
  "total_amount",
  "totalamount",
  "count",
  "first_date",
  "firstdate",
  "last_date",
  "lastdate",
]);

/**
 * The creation-route reject check. Callers should ALSO validate the key
 * against `CUSTOM_FIELD_KEY_PATTERN` — this function only answers the
 * collision question.
 */
export function isReservedKey(key: string): boolean {
  const normalized = key.toLowerCase();
  if (RESERVED_KEYS.has(normalized)) {
    return true;
  }
  return RESERVED_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}
